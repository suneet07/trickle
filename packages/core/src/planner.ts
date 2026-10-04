import { AccountForCap, CapConfig, DEFAULT_CAP_CONFIG, computeCap } from "./cap.js";
import {
  generateSlots,
  GeneratedSlot,
  SlotLead,
  SlotOptions,
  DeferReason,
  DeferredLead,
} from "./slots.js";
import { SendWindow } from "./windows.js";
import { Rng } from "./util.js";

/**
 * Daily-planner assembly. Pure and deterministic given an rng;
 * the worker wraps this with DB reads/writes and BullMQ enqueue.
 */

export interface PlannerAccount extends AccountForCap {
  id: string;
  // Recipient domains this account already emailed in the last 24h.
  recentDomains?: string[];
  // Emails this inbox has already SENT today (from SendLog.coldSent).
  sentToday?: number;
  // Emails already planned/queued for today (not yet sent). Together with
  // sentToday these make the cap idempotent — see computeCap(alreadyUsed).
  outstandingToday?: number;
  // Per-inbox send-window override (falls back to campaign/default windows).
  sendWindows?: SendWindow[];
  // Per-inbox per-clock-hour ceiling.
  hourlyCap?: number;
  // Per-inbox hard minimum gap (minutes) between sends.
  minGapMinutes?: number;
}

export interface PlannerLead extends SlotLead {
  accountId: string; // lead keeps its assigned sending account
}

export interface PlannedAssignment {
  accountId: string;
  slots: GeneratedSlot[];
  deferredLeadIds: string[];
  // Why each deferred lead was held back (cap / domain_dedupe / hourly_cap /
  // window_overflow), so the UI can explain a short day.
  deferredReasons: DeferredLead[];
  // The idempotent cap this account was planned against today (after
  // subtracting what it already sent/queued).
  capToday: number;
}

export interface PlanResult {
  date: Date;
  dailyBudget: number;
  assignments: PlannedAssignment[];
  totalScheduled: number;
  // Rollup of deferral reasons across all accounts.
  deferredByReason: Record<DeferReason, number>;
}

export interface PlanOptions {
  capConfig?: CapConfig;
  rng?: Rng;
  slotOptions?: Omit<SlotOptions, "rng" | "recentDomains" | "accountStaggerSec">;
  // Seconds between account start offsets so no two inboxes send within 90s.
  accountStaggerStepSec?: number;
  // Timezone used to resolve the business day; per-lead tz still drives windows.
  // Most regions are single-tz so we group by the lead's own tz.
}

/**
 * Build one day's plan across accounts. Leads must already be filtered
 * (not suppressed, eligible status, follow-ups first) by the caller.
 */
export function planDay(
  date: Date,
  accounts: PlannerAccount[],
  leadsByAccount: Map<string, PlannerLead[]>,
  opts: PlanOptions = {},
): PlanResult {
  const cfg = opts.capConfig ?? DEFAULT_CAP_CONFIG;
  const rng = opts.rng ?? Math.random;
  const staggerStep = opts.accountStaggerStepSec ?? 95; // keeps inboxes >90s apart

  const assignments: PlannedAssignment[] = [];
  let remainingGlobal = cfg.globalCeiling;
  let acctIndex = 0;
  let totalScheduled = 0;
  const deferredByReason: Record<DeferReason, number> = {
    cap: 0,
    domain_dedupe: 0,
    hourly_cap: 0,
    window_overflow: 0,
  };
  const tallyReasons = (rs: DeferredLead[]) => {
    for (const r of rs) deferredByReason[r.reason]++;
  };

  for (const account of accounts) {
    // Idempotent cap: subtract what this inbox already sent AND already has
    // queued/planned for today, so re-planning can only top up to the cap.
    const usedToday = (account.sentToday ?? 0) + (account.outstandingToday ?? 0);
    const capToday = Math.min(computeCap(account, cfg, usedToday), remainingGlobal);
    const leads = leadsByAccount.get(account.id) ?? [];
    if (capToday <= 0 || leads.length === 0) {
      assignments.push({
        accountId: account.id,
        slots: [],
        deferredLeadIds: leads.map((l) => l.leadId),
        deferredReasons: leads.map((l) => ({
          leadId: l.leadId,
          reason: "cap" as DeferReason,
        })),
        capToday: Math.max(0, capToday),
      });
      if (capToday <= 0) tallyReasons(leads.map((l) => ({ leadId: l.leadId, reason: "cap" })));
      continue;
    }
    const cap = capToday;

    // Group this account's leads by timezone (regions are usually single-tz,
    // but mixed imports still work).
    const byTz = new Map<string, PlannerLead[]>();
    for (const l of leads) {
      const arr = byTz.get(l.timezone) ?? [];
      arr.push(l);
      byTz.set(l.timezone, arr);
    }

    const acctSlots: GeneratedSlot[] = [];
    const acctDeferred: string[] = [];
    const acctDeferredReasons: DeferredLead[] = [];
    let capLeft = cap;
    const stagger = acctIndex * staggerStep;

    for (const [tz, tzLeads] of byTz) {
      if (capLeft <= 0) {
        acctDeferred.push(...tzLeads.map((l) => l.leadId));
        acctDeferredReasons.push(
          ...tzLeads.map((l) => ({ leadId: l.leadId, reason: "cap" as DeferReason })),
        );
        continue;
      }
      const { slots, deferred, deferredReasons } = generateSlots(capLeft, tzLeads, date, tz, {
        ...(opts.slotOptions ?? {}),
        // Per-inbox overrides win over campaign/default slot options.
        ...(account.sendWindows ? { windows: account.sendWindows } : {}),
        ...(account.hourlyCap ? { hourlyCap: account.hourlyCap } : {}),
        ...(account.minGapMinutes ? { minGapMinutes: account.minGapMinutes } : {}),
        rng,
        accountStaggerSec: stagger,
        recentDomains: new Set(account.recentDomains ?? []),
      });
      acctSlots.push(...slots);
      acctDeferred.push(...deferred.map((d) => d.leadId));
      acctDeferredReasons.push(...deferredReasons);
      capLeft -= slots.length;
    }

    acctSlots.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
    tallyReasons(acctDeferredReasons);
    assignments.push({
      accountId: account.id,
      slots: acctSlots,
      deferredLeadIds: acctDeferred,
      deferredReasons: acctDeferredReasons,
      capToday: cap,
    });
    totalScheduled += acctSlots.length;
    remainingGlobal -= acctSlots.length;
    acctIndex++;
  }

  const budget = Math.min(
    cfg.globalCeiling,
    accounts.reduce((s, a) => s + computeCap(a, cfg), 0),
  );

  return { date, dailyBudget: budget, assignments, totalScheduled, deferredByReason };
}

/** Estimate business-days to complete a backlog of N leads at a daily budget. */
export function estimateCompletionDays(
  backlog: number,
  dailyBudget: number,
): number {
  if (dailyBudget <= 0) return Infinity;
  return Math.ceil(backlog / dailyBudget);
}
