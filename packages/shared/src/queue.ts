import { Queue, QueueEvents, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@trickle/db";
import { env } from "./env.js";

// A single shared ioredis connection reused across queues/workers. Typed as
// BullMQ's ConnectionOptions because BullMQ bundles its own copy of ioredis, so
// the workspace's Redis type isn't structurally identical (runtime is fine).
export const connection = new Redis(env.redisUrl(), {
  maxRetriesPerRequest: null,
}) as unknown as ConnectionOptions;

export const QUEUE_NAMES = {
  send: "send-email",
  poll: "poll-replies",
  health: "health-check",
  planner: "daily-planner",
  reconcile: "reconcile",
  warmup: "warmup",
  placement: "placement-test",
} as const;

// Default retry policy for sends: transient Gmail errors (429/403) are thrown
// by the job so BullMQ retries them with exponential backoff instead of
// dropping the send after a single attempt.
export const sendQueue = new Queue(QUEUE_NAMES.send, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: true,
  },
});
export const pollQueue = new Queue(QUEUE_NAMES.poll, { connection });
export const healthQueue = new Queue(QUEUE_NAMES.health, { connection });
export const plannerQueue = new Queue(QUEUE_NAMES.planner, { connection });
export const reconcileQueue = new Queue(QUEUE_NAMES.reconcile, { connection });
export const warmupQueue = new Queue(QUEUE_NAMES.warmup, { connection });
// Placement test: "send" phase job, then a delayed "check" phase job.
export const placementQueue = new Queue(QUEUE_NAMES.placement, { connection });

export interface SendJobData {
  messageId: string;
}

/**
 * Enqueue a send for a specific instant (used by manual queue edits: reschedule
 * a send to a new time, or release a held message). Returns the new BullMQ job
 * id so the caller can store it on the Message for later cancellation.
 */
export async function scheduleSend(
  messageId: string,
  sendAt: Date,
): Promise<string | undefined> {
  const delay = Math.max(0, sendAt.getTime() - Date.now());
  const job = await sendQueue.add(
    "send-email",
    { messageId },
    { delay, removeOnComplete: true },
  );
  return job.id ?? undefined;
}

/** Cancel a scheduled send job (used when a reply/bounce cancels follow-ups). */
export async function cancelSendJob(jobId: string | null | undefined) {
  if (!jobId) return;
  const job = await sendQueue.getJob(jobId);
  if (job) {
    const state = await job.getState();
    // Only remove jobs that haven't started running yet.
    if (state === "delayed" || state === "waiting" || state === "waiting-children")
      await job.remove();
  }
}

/**
 * Cancel every still-queued send for a campaign and remove its BullMQ jobs.
 * Called when a campaign is paused or archived so
 * that already-queued sends for the day don't go out anyway.
 *
 * Messages are reset to `planned` (NOT `canceled`): on resume the planner
 * re-slots planned rows, so a paused campaign picks up where it left off.
 * Canceling here would strand the campaign forever — the leads already have a
 * message row, so they'd never be re-planned.
 */
export async function cancelCampaignQueued(campaignId: string): Promise<number> {
  const queued = await prisma.message.findMany({
    where: { campaignId, direction: "out", status: { in: ["queued", "planned"] } },
    select: { id: true, bulljobId: true },
  });
  for (const m of queued) await cancelSendJob(m.bulljobId);
  const res = await prisma.message.updateMany({
    where: { campaignId, direction: "out", status: { in: ["queued", "planned"] } },
    data: { status: "planned", bulljobId: null },
  });
  return res.count;
}

export function newQueueEvents(name: string) {
  return new QueueEvents(name, { connection });
}
