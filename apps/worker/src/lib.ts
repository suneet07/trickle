import { DateTime } from "luxon";
import { prisma, Account } from "@trickle/db";
import { env } from "@trickle/shared";
import type { AccountForCap, CapConfig, SendWindow } from "@trickle/core";

export function capConfig(): CapConfig {
  return { totalCap: env.perInboxTotalCap(), globalCeiling: env.globalDailyCap() };
}

export function accountAgeDays(a: Account): number {
  // Already-warmed inboxes skip the ramp (treated as fully mature).
  if (a.warmedUp) return 999;
  return Math.max(0, Math.floor((Date.now() - a.createdAt.getTime()) / 86400000));
}

export function toCapAccount(a: Account): AccountForCap & { id: string } {
  return {
    id: a.id,
    capColdBase: a.dailyCapCold,
    warmupVolumeManual: a.warmupVolumeManual,
    healthScore: a.healthScore,
    accountAgeDays: accountAgeDays(a),
  };
}

export function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export const todayUtc = () => DateTime.utc().startOf("day").toJSDate();

/** Increment (or create) today's SendLog counters for an account. */
export async function bumpSendLog(
  accountId: string,
  field: "coldSent" | "warmupSent" | "bounces" | "replies" | "gmailErr",
  by = 1,
) {
  const date = todayUtc();
  await prisma.sendLog.upsert({
    where: { accountId_date: { accountId, date } },
    update: { [field]: { increment: by } },
    create: { accountId, date, [field]: by },
  });
}

/**
 * How much of an inbox's daily cap is already spoken for TODAY (UTC day):
 * `sent` = actually sent (SendLog.coldSent), `outstanding` = still-queued jobs
 * that will fire today. The planner subtracts (sent + outstanding) from the cap
 * so re-planning only ever tops up — never stacks a fresh cap on top.
 */
export async function usageToday(
  accountId: string,
): Promise<{ sent: number; outstanding: number }> {
  const date = todayUtc();
  const dayEnd = DateTime.fromJSDate(date).plus({ days: 1 }).toJSDate();
  const [log, outstanding] = await Promise.all([
    prisma.sendLog.findUnique({ where: { accountId_date: { accountId, date } } }),
    prisma.message.count({
      where: {
        accountId,
        direction: "out",
        status: "queued",
        scheduledAt: { gte: date, lt: dayEnd },
      },
    }),
  ]);
  return { sent: log?.coldSent ?? 0, outstanding };
}

/** Parse an inbox's per-inbox send-window override, if any is set + valid. */
export function accountWindows(a: Account): SendWindow[] | undefined {
  const raw = a.sendWindowsJson as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const windows = raw
    .filter(
      (w): w is SendWindow =>
        !!w &&
        typeof (w as any).startMin === "number" &&
        typeof (w as any).endMin === "number" &&
        typeof (w as any).weight === "number" &&
        (w as any).endMin > (w as any).startMin,
    )
    .map((w) => ({ startMin: w.startMin, endMin: w.endMin, weight: w.weight }));
  return windows.length ? windows : undefined;
}

/** Recipient domains an account has emailed in the last 24h (domain dedupe). */
export async function recentDomains(accountId: string): Promise<string[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const msgs = await prisma.message.findMany({
    where: {
      accountId,
      direction: "out",
      status: { in: ["sent", "queued", "planned"] },
      OR: [{ sentAt: { gte: since } }, { scheduledAt: { gte: since } }],
    },
    include: { lead: { select: { email: true } } },
  });
  return [...new Set(msgs.map((m) => domainOf(m.lead.email)))];
}
