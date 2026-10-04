import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma, Prisma } from "@trickle/db";
import { capBreakdown } from "@trickle/core";
import { env, scheduleSend, cancelSendJob } from "@trickle/shared";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";

export default async function dashboardRoutes(app: FastifyInstance) {
  // Per-account overview: sent today vs cap, warmup, health, rates.
  app.get("/api/dashboard/accounts", { preHandler: requireAuth }, async () => {
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    const todayUtc = DateTime.utc().startOf("day").toJSDate();
    const tomorrowUtc = DateTime.utc().startOf("day").plus({ days: 1 }).toJSDate();
    const cfg = { totalCap: env.perInboxTotalCap(), globalCeiling: env.globalDailyCap() };

    return Promise.all(
      accounts.map(async (a) => {
        const [log, outstanding] = await Promise.all([
          prisma.sendLog.findUnique({
            where: { accountId_date: { accountId: a.id, date: todayUtc } },
          }),
          prisma.message.count({
            where: {
              accountId: a.id,
              direction: "out",
              status: "queued",
              scheduledAt: { gte: todayUtc, lt: tomorrowUtc },
            },
          }),
        ]);
        const ageDays = a.warmedUp
          ? 999
          : Math.max(0, Math.floor((Date.now() - a.createdAt.getTime()) / 86400000));
        const sentToday = log?.coldSent ?? 0;
        const usedToday = sentToday + outstanding;
        const bd = capBreakdown(
          {
            capColdBase: a.dailyCapCold,
            warmupVolumeManual: a.warmupVolumeManual,
            healthScore: a.healthScore,
            accountAgeDays: ageDays,
          },
          cfg,
          usedToday,
        );
        return {
          id: a.id,
          email: a.email,
          status: a.status,
          healthScore: a.healthScore,
          warmupVolume: a.warmupVolumeManual,
          // Back-compat: capCold == the full daily cap (before usage).
          capCold: bd.effectiveCap,
          // Full, honest breakdown so the UI can explain the number.
          capBreakdown: bd,
          queuedToday: outstanding,
          sentToday,
          bouncesToday: log?.bounces ?? 0,
          repliesToday: log?.replies ?? 0,
          // Per-inbox scheduling controls.
          hourlyCap: a.hourlyCap,
          minGapMinutes: a.minGapMinutes,
          sendWindows: a.sendWindowsJson ?? null,
          pausedUntil: a.pausedUntil,
        };
      }),
    );
  });

  // Per-inbox day plan: for a given UTC date, group every planned/queued send
  // by inbox with hourly buckets + the exact ordered slot list, plus each
  // inbox's cap and how much is already used. This is the "how many, from which
  // inbox, when" overview.
  app.get("/api/dashboard/schedule", { preHandler: requireAuth }, async (req) => {
    const q = z.object({ date: z.string().optional() }).parse(req.query);
    const day = q.date
      ? DateTime.fromISO(q.date, { zone: "utc" }).startOf("day")
      : DateTime.utc().startOf("day");
    const start = day.toJSDate();
    const end = day.plus({ days: 1 }).toJSDate();
    const cfg = { totalCap: env.perInboxTotalCap(), globalCeiling: env.globalDailyCap() };

    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    const rows = await prisma.message.findMany({
      where: {
        direction: "out",
        status: { in: ["planned", "queued"] },
        scheduledAt: { gte: start, lt: end },
        OR: [{ campaignId: null }, { campaign: { status: "running" } }],
      },
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true,
        status: true,
        stepIndex: true,
        scheduledAt: true,
        accountId: true,
        lead: { select: { name: true, email: true, timezone: true } },
        campaign: { select: { name: true } },
      },
    });

    const byAccount = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.accountId) continue;
      const arr = byAccount.get(r.accountId) ?? [];
      arr.push(r);
      byAccount.set(r.accountId, arr);
    }

    const isToday = day.hasSame(DateTime.utc(), "day");
    return {
      date: day.toISODate(),
      inboxes: await Promise.all(
        accounts.map(async (a) => {
          const slots = byAccount.get(a.id) ?? [];
          const ageDays = a.warmedUp
            ? 999
            : Math.max(0, Math.floor((Date.now() - a.createdAt.getTime()) / 86400000));
          // "Used today" only meaningful for today's date.
          let usedToday = 0;
          if (isToday) {
            const log = await prisma.sendLog.findUnique({
              where: { accountId_date: { accountId: a.id, date: start } },
            });
            usedToday = log?.coldSent ?? 0;
          }
          const bd = capBreakdown(
            {
              capColdBase: a.dailyCapCold,
              warmupVolumeManual: a.warmupVolumeManual,
              healthScore: a.healthScore,
              accountAgeDays: ageDays,
            },
            cfg,
            usedToday + slots.filter((s) => s.status === "queued").length,
          );
          // Hourly histogram keyed by the lead-local hour is ambiguous across
          // tzs; bucket by UTC hour of the scheduled instant for a stable view.
          const hourly: Record<number, number> = {};
          for (const s of slots) {
            if (!s.scheduledAt) continue;
            const h = DateTime.fromJSDate(s.scheduledAt).toUTC().hour;
            hourly[h] = (hourly[h] ?? 0) + 1;
          }
          return {
            id: a.id,
            email: a.email,
            status: a.status,
            effectiveCap: bd.effectiveCap,
            usedToday: bd.usedToday,
            remainingToday: bd.remainingToday,
            // plannedCount mixes both statuses and is kept for compatibility.
            // The cap only consumes `queued` rows, so report them separately:
            // `backlog` rows carry today's scheduledAt but hold no BullMQ job
            // and are promoted by a later daily-planner pass as cap frees up.
            plannedCount: slots.length,
            queuedCount: slots.filter((s) => s.status === "queued").length,
            backlogCount: slots.filter((s) => s.status === "planned").length,
            hourly,
            slots: slots.map((s) => ({
              id: s.id,
              status: s.status,
              stepIndex: s.stepIndex,
              scheduledAt: s.scheduledAt,
              lead: s.lead,
              campaign: s.campaign,
            })),
          };
        }),
      ),
    };
  });

  // --- Editable queue --------------------------------------------------------

  // Reschedule a single send to a new time (cancels the old BullMQ job and
  // re-enqueues at the new instant). Only affects still-queued/planned sends.
  app.patch("/api/queue/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        scheduledAt: z.string().datetime().optional(),
        accountId: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.direction !== "out")
      return reply.code(404).send({ error: "not_found" });
    if (!["planned", "queued"].includes(msg.status))
      return reply.code(409).send({ error: "not_editable", status: msg.status });

    // Reassign inbox: the send job reads accountId from the DB at send time,
    // so updating the row is enough (no job churn needed).
    const data: Record<string, unknown> = {};
    if (body.data.accountId !== undefined) data.accountId = body.data.accountId;

    // Reschedule: cancel the old job, enqueue a new one at the new instant.
    if (body.data.scheduledAt) {
      const when = new Date(body.data.scheduledAt);
      await cancelSendJob(msg.bulljobId);
      const jobId = await scheduleSend(msg.id, when);
      data.scheduledAt = when;
      data.status = "queued";
      data.bulljobId = jobId ?? null;
    }

    const updated = await prisma.message.update({ where: { id }, data });
    await audit("queue.edit", id, body.data as Record<string, unknown>);
    return { ok: true, id: updated.id, scheduledAt: updated.scheduledAt, accountId: updated.accountId };
  });

  // Hold a send: cancel its job and park it (status=planned, no scheduledAt) so
  // neither the queue nor the nightly planner will fire it until released.
  app.post("/api/queue/:id/hold", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.direction !== "out")
      return reply.code(404).send({ error: "not_found" });
    if (!["planned", "queued"].includes(msg.status))
      return reply.code(409).send({ error: "not_editable", status: msg.status });
    await cancelSendJob(msg.bulljobId);
    await prisma.message.update({
      where: { id },
      data: { status: "planned", scheduledAt: null, bulljobId: null },
    });
    await audit("queue.hold", id);
    return { ok: true };
  });

  // Release a held send: re-enqueue it, either at a given time or immediately.
  app.post("/api/queue/:id/release", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ sendAt: z.string().datetime().optional() }).safeParse(req.body);
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.direction !== "out")
      return reply.code(404).send({ error: "not_found" });
    if (msg.status !== "planned")
      return reply.code(409).send({ error: "not_held", status: msg.status });
    const when = body.success && body.data.sendAt ? new Date(body.data.sendAt) : new Date();
    const jobId = await scheduleSend(msg.id, when);
    await prisma.message.update({
      where: { id },
      data: { status: "queued", scheduledAt: when, bulljobId: jobId ?? null },
    });
    await audit("queue.release", id, { sendAt: when.toISOString() });
    return { ok: true, scheduledAt: when };
  });

  // Per-campaign progress.
  app.get("/api/dashboard/campaigns", { preHandler: requireAuth }, async () => {
    const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
    return Promise.all(
      campaigns.map(async (c) => {
        const [sent, replies, bounces] = await Promise.all([
          prisma.message.count({ where: { campaignId: c.id, status: "sent", direction: "out" } }),
          prisma.message.count({ where: { campaignId: c.id, direction: "in" } }),
          prisma.message.count({ where: { campaignId: c.id, status: "bounced" } }),
        ]);
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          sent,
          replies,
          bounces,
          replyRate: sent ? replies / sent : 0,
        };
      }),
    );
  });

  // Global send calendar: planned volume for the next 7 days.
  app.get("/api/dashboard/calendar", { preHandler: requireAuth }, async () => {
    const start = DateTime.utc().startOf("day");
    const end = start.plus({ days: 7 });
    const planned = await prisma.message.findMany({
      where: {
        direction: "out",
        status: { in: ["planned", "queued"] },
        scheduledAt: { gte: start.toJSDate(), lt: end.toJSDate() },
      },
      select: { scheduledAt: true },
    });
    const buckets: Record<string, number> = {};
    for (let i = 0; i < 7; i++) buckets[start.plus({ days: i }).toISODate()!] = 0;
    for (const m of planned) {
      if (!m.scheduledAt) continue;
      const key = DateTime.fromJSDate(m.scheduledAt).toUTC().toISODate()!;
      if (key in buckets) buckets[key]!++;
    }
    return Object.entries(buckets).map(([date, count]) => ({ date, count }));
  });

  // Full send queue: every planned/queued outbound with lead, inbox, campaign,
  // step and exact scheduled time (soonest first).
  app.get("/api/dashboard/queue", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(30).default(7),
        take: z.coerce.number().int().min(1).max(500).default(200),
        skip: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const end = DateTime.utc().plus({ days: q.days }).toJSDate();
    const where: Prisma.MessageWhereInput = {
      direction: "out",
      status: { in: ["planned", "queued"] },
      scheduledAt: { lte: end },
      // Paused campaigns' rows are dormant (re-slotted on resume) — hide them.
      OR: [{ campaignId: null }, { campaign: { status: "running" } }],
    };
    const [total, items] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        take: q.take,
        skip: q.skip,
        select: {
          id: true,
          status: true,
          stepIndex: true,
          subject: true,
          scheduledAt: true,
          lead: { select: { name: true, email: true, timezone: true } },
          account: { select: { email: true } },
          campaign: { select: { name: true } },
        },
      }),
    ]);
    return { total, items };
  });

  // Historical daily metrics (aggregated across inboxes) for charts.
  app.get("/api/dashboard/history", { preHandler: requireAuth }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
    const start = DateTime.utc().startOf("day").minus({ days: q.days - 1 });
    const logs = await prisma.sendLog.findMany({
      where: { date: { gte: start.toJSDate() } },
      orderBy: { date: "asc" },
    });
    const buckets = new Map<string, { date: string; sent: number; bounces: number; replies: number }>();
    for (let i = 0; i < q.days; i++) {
      const key = start.plus({ days: i }).toISODate()!;
      buckets.set(key, { date: key, sent: 0, bounces: 0, replies: 0 });
    }
    for (const l of logs) {
      const key = DateTime.fromJSDate(l.date).toUTC().toISODate()!;
      const b = buckets.get(key);
      if (b) {
        b.sent += l.coldSent + l.warmupSent;
        b.bounces += l.bounces;
        b.replies += l.replies;
      }
    }
    return [...buckets.values()];
  });

  // Admin activity log: recent system events + audited user actions, merged.
  app.get("/api/events", { preHandler: requireAuth }, async (req) => {
    const q = z.object({ take: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const [events, audits] = await Promise.all([
      prisma.event.findMany({ orderBy: { createdAt: "desc" }, take: q.take }),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: q.take }),
    ]);
    const merged = [
      ...events.map((e) => ({ id: e.id, kind: "event" as const, type: e.type, detail: e.payload, createdAt: e.createdAt })),
      ...audits.map((a) => ({ id: a.id, kind: "audit" as const, type: a.action, detail: { target: a.target, ...(a.detail as object) }, createdAt: a.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(0, q.take);
  });

  app.get("/healthz", async () => {
    const hb = await prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } });
    const workerStale =
      !hb || Date.now() - hb.beatAt.getTime() > 15 * 60_000;
    return { ok: true, workerStale };
  });
}
