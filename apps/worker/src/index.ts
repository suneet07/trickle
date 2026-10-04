import { Worker } from "bullmq";
import { prisma } from "@trickle/db";
import {
  connection,
  QUEUE_NAMES,
  plannerQueue,
  pollQueue,
  healthQueue,
  reconcileQueue,
  warmupQueue,
  alert,
  assertEnv,
  env,
} from "@trickle/shared";
import { processSend } from "./jobs/send-email.js";
import { runDailyPlanner } from "./jobs/daily-planner.js";
import { processPollReplies } from "./jobs/poll-replies.js";
import { processHealthCheck } from "./jobs/health-check.js";
import { processReconcile } from "./jobs/reconcile.js";
import { processWarmup } from "./jobs/warmup.js";
import { processPlacementTest, type PlacementJobData } from "./jobs/placement-test.js";

assertEnv("worker");

// --- Workers ---------------------------------------------------------------

const sendWorker = new Worker(
  QUEUE_NAMES.send,
  async (job) => {
    await processSend(job.data.messageId as string);
  },
  {
    connection,
    concurrency: 3,
    // Exponential backoff for transient Gmail errors is set per-job
    // (see sendQueue defaultJobOptions in @trickle/shared).
  },
);

const plannerWorker = new Worker(
  QUEUE_NAMES.planner,
  async () => {
    await runDailyPlanner(new Date());
    await checkReplyRateFloor();
  },
  { connection, concurrency: 1 },
);

const pollWorker = new Worker(
  QUEUE_NAMES.poll,
  async () => {
    const accounts = await prisma.account.findMany({
      where: { status: { not: "paused" } },
    });
    for (const a of accounts) {
      try {
        await processPollReplies(a.id);
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(`poll-replies ${a.email}:`, err?.message);
      }
    }
  },
  { connection, concurrency: 1 },
);

const healthWorker = new Worker(
  QUEUE_NAMES.health,
  async () => {
    await processHealthCheck();
  },
  { connection, concurrency: 1 },
);

const reconcileWorker = new Worker(
  QUEUE_NAMES.reconcile,
  async () => {
    await processReconcile();
  },
  { connection, concurrency: 1 },
);

const warmupWorker = new Worker(
  QUEUE_NAMES.warmup,
  async () => {
    await processWarmup();
  },
  { connection, concurrency: 1 },
);

const placementWorker = new Worker(
  QUEUE_NAMES.placement,
  async (job) => {
    await processPlacementTest(job.data as PlacementJobData);
  },
  { connection, concurrency: 1 },
);

for (const w of [
  sendWorker,
  plannerWorker,
  pollWorker,
  healthWorker,
  reconcileWorker,
  warmupWorker,
  placementWorker,
]) {
  w.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[${w.name}] job ${job?.id} failed:`, err?.message);
  });
}

/**
 * Reply-rate floor: observe and report, never pause.
 *
 * Reply rate measures whether copy converts, not whether sending does harm.
 * The harm signals (bounces, DNSBL listings, SPF/DMARC failures, send errors)
 * are watched by health-check and the per-inbox bounce breaker, which pause
 * things on their own. Pausing a campaign on low replies would also freeze its
 * in-flight follow-ups, which is where most replies come from.
 *
 * So this only reports: once a running campaign has a meaningful sample and
 * sits under 1%, raise an informational alert, at most once a week per
 * campaign. Run a placement test before assuming it is the copy.
 */
const REPLY_FLOOR_MIN_SAMPLE = 400;
const REPLY_FLOOR_NOTICE_TYPE = "reply_rate_low";
const REPLY_FLOOR_NOTICE_COOLDOWN_DAYS = 7;

async function checkReplyRateFloor() {
  const running = await prisma.campaign.findMany({ where: { status: "running" } });
  for (const c of running) {
    const sent = await prisma.message.count({
      where: { campaignId: c.id, direction: "out", status: "sent" },
    });
    if (sent < REPLY_FLOOR_MIN_SAMPLE) continue;
    const replies = await prisma.message.count({
      where: { campaignId: c.id, direction: "in" },
    });
    if (replies / sent >= 0.01) continue;

    // At most one notice per campaign per week.
    const since = new Date(
      Date.now() - REPLY_FLOOR_NOTICE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
    );
    const recent = await prisma.event.findFirst({
      where: {
        type: REPLY_FLOOR_NOTICE_TYPE,
        createdAt: { gte: since },
        payload: { path: ["campaignId"], equals: c.id },
      },
    });
    if (recent) continue;

    await prisma.event
      .create({
        data: {
          type: REPLY_FLOOR_NOTICE_TYPE,
          payload: { campaignId: c.id, campaign: c.name, sent, replies },
        },
      })
      .catch(() => {});
    await alert(
      "Reply rate below 1%",
      `"${c.name}" ${replies} replies / ${sent} sent. Not paused — informational. ` +
        `If this is unexpected, run a placement test before assuming it is the copy.`,
    );
  }
}

// --- Repeatable schedules --------------------------------------------------

async function registerRepeatables() {
  // daily-planner @ 00:05 UTC
  await plannerQueue.add(
    "plan",
    {},
    { repeat: { pattern: "5 0 * * *", tz: "UTC" }, removeOnComplete: true },
  );
  // poll-replies every 10 minutes
  await pollQueue.add(
    "poll",
    {},
    { repeat: { every: 10 * 60_000 }, removeOnComplete: true },
  );
  // health-check daily @ 00:20 UTC (after planning)
  await healthQueue.add(
    "health",
    {},
    { repeat: { pattern: "20 0 * * *", tz: "UTC" }, removeOnComplete: true },
  );
  // reconcile stuck `queued` messages hourly (recovers from a redis wipe).
  await reconcileQueue.add(
    "reconcile",
    {},
    { repeat: { every: 60 * 60_000 }, removeOnComplete: true },
  );
  // warmup automation: spread across business hours (3x/day) so peer traffic
  // doesn't arrive in a single burst.
  await warmupQueue.add(
    "warmup",
    {},
    { repeat: { pattern: "0 9,13,17 * * *", tz: "UTC" }, removeOnComplete: true },
  );
}

await registerRepeatables();

// eslint-disable-next-line no-console
console.log(
  `Trickle worker started (${env.sendLive() ? "LIVE sending" : "dry-run: no email is actually sent"}).`,
);

// Heartbeat every minute so /healthz can detect a dead worker. beatAt is set
// explicitly: Prisma's `update: {}` would write nothing on an existing row.
async function beat() {
  const now = new Date();
  try {
    await prisma.workerHeartbeat.upsert({
      where: { id: "singleton" },
      update: { beatAt: now },
      create: { id: "singleton", beatAt: now },
    });
  } catch {
    // Best-effort: a heartbeat write must never take the worker down.
  }
}

// Beat once at boot so a restart clears staleness immediately rather than
// leaving a 60s window where /healthz still reports the worker dead.
await beat();
setInterval(beat, 60_000);

async function shutdown() {
  await Promise.all([
    sendWorker.close(),
    plannerWorker.close(),
    pollWorker.close(),
    healthWorker.close(),
    reconcileWorker.close(),
    warmupWorker.close(),
    placementWorker.close(),
  ]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
