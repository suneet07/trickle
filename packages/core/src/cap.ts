import { clamp } from "./util.js";

/** Per-inbox daily budget and the internal health score. */

export interface CapConfig {
  totalCap: number; // safe Gmail total/day (default 40)
  globalCeiling: number; // G (default 100)
}

export const DEFAULT_CAP_CONFIG: CapConfig = {
  totalCap: 40,
  globalCeiling: 100,
};

export interface AccountForCap {
  capColdBase: number; // default 25
  warmupVolumeManual: number; // default 15
  healthScore: number; // 0..100
  accountAgeDays: number;
}

/** healthMultiplier: 1.0 if >=90, 0.6 if 70-89, 0.3 if 50-69, 0 if <50. */
export function healthMultiplier(health: number): number {
  if (health >= 90) return 1.0;
  if (health >= 70) return 0.6;
  if (health >= 50) return 0.3;
  return 0; // quarantine
}

/** rampFactor for new inboxes: d1-7 -> .3, 8-14 -> .5, 15-21 -> .75, 22+ -> 1. */
export function rampFactor(ageDays: number): number {
  if (ageDays <= 7) return 0.3;
  if (ageDays <= 14) return 0.5;
  if (ageDays <= 21) return 0.75;
  return 1.0;
}

/**
 * capCold[a] for a single account. Warmup always has priority: cold shrinks so
 * combined outbound never exceeds totalCap.
 *
 * `alreadyUsed` = emails this inbox has already sent AND/OR still has queued
 * for today. Subtracting it makes the cap idempotent: re-running the planner,
 * resuming a paused campaign, or a mid-day campaign start can only ever "top
 * up" to the daily cap — never stack a fresh cap on top of what already went
 * out. Defaults to 0 so existing callers/tests keep their behavior.
 */
export function computeCap(
  a: AccountForCap,
  cfg: CapConfig = DEFAULT_CAP_CONFIG,
  alreadyUsed = 0,
): number {
  const capCold = computeBaseCap(a, cfg);
  return Math.max(0, capCold - Math.max(0, Math.floor(alreadyUsed)));
}

/** The full daily cold cap for an inbox BEFORE subtracting today's usage. */
function computeBaseCap(a: AccountForCap, cfg: CapConfig): number {
  const headroom = Math.max(0, cfg.totalCap - a.warmupVolumeManual);
  let capCold = Math.min(a.capColdBase, headroom);
  capCold *= healthMultiplier(a.healthScore);
  capCold *= rampFactor(a.accountAgeDays);
  return Math.floor(capCold);
}

export interface CapBreakdown {
  base: number; // dailyCapCold as configured
  warmupVolume: number; // subtracted first (warmup has priority)
  headroomAfterWarmup: number; // min(base, totalCap - warmup)
  healthMultiplier: number; // 0 / 0.3 / 0.6 / 1.0
  rampFactor: number; // 0.3 / 0.5 / 0.75 / 1.0
  effectiveCap: number; // full cap for the day (before usage)
  usedToday: number; // sent + still-queued today
  remainingToday: number; // effectiveCap - usedToday, floored at 0
}

/**
 * Explain exactly how an inbox's cap was derived, so the UI can show
 * "40 → 25 (warmup −15) → ×0.6 health → ×1.0 age = 15/day · 9 used · 6 left"
 * instead of a single opaque number.
 */
export function capBreakdown(
  a: AccountForCap,
  cfg: CapConfig = DEFAULT_CAP_CONFIG,
  usedToday = 0,
): CapBreakdown {
  const headroomAfterWarmup = Math.min(
    a.capColdBase,
    Math.max(0, cfg.totalCap - a.warmupVolumeManual),
  );
  const effectiveCap = computeBaseCap(a, cfg);
  const used = Math.max(0, Math.floor(usedToday));
  return {
    base: a.capColdBase,
    warmupVolume: a.warmupVolumeManual,
    headroomAfterWarmup,
    healthMultiplier: healthMultiplier(a.healthScore),
    rampFactor: rampFactor(a.accountAgeDays),
    effectiveCap,
    usedToday: used,
    remainingToday: Math.max(0, effectiveCap - used),
  };
}

/** dailyBudget = min(G, Σ capCold[a]). */
export function dailyBudget(
  accounts: AccountForCap[],
  cfg: CapConfig = DEFAULT_CAP_CONFIG,
): number {
  const sum = accounts.reduce((acc, a) => acc + computeCap(a, cfg), 0);
  return Math.min(cfg.globalCeiling, sum);
}

export interface HealthInputs {
  bounceRate7d: number; // 0..1
  gmailErrRate7d: number; // 0..1
  replyRate7d: number; // 0..1
  dnsblListed: boolean;
  spfDkimDmarcFail: boolean;
}

/**
 * Internal health score 0..100, from the app's own 7-day signals. Bounces and
 * provider send errors pull it down, DNSBL listings and missing SPF/DMARC cost a
 * flat penalty, and genuine replies add a small capped bonus.
 */
export function computeHealth(i: HealthInputs): number {
  let health = 100;
  health -= 30 * clamp(i.bounceRate7d / 0.05);
  health -= 25 * clamp(i.gmailErrRate7d / 0.1);
  health -= 15 * (i.dnsblListed ? 1 : 0);
  health -= 10 * (i.spfDkimDmarcFail ? 1 : 0);
  health += 10 * clamp(i.replyRate7d / 0.05);
  return Math.round(clamp(health, 0, 100));
}
