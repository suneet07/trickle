import { DateTime } from "luxon";
import { isHoliday } from "./holidays.js";
import {
  DEFAULT_WEEKDAY_WEIGHTS,
  DEFAULT_WINDOWS,
  SendWindow,
  weekdayWeight,
} from "./windows.js";
import { isFreemail, logNormalGap, Rng } from "./util.js";

export interface SlotLead {
  leadId: string;
  timezone: string; // IANA
  domain: string; // recipient email domain (for 24h domain-dedupe)
}

export interface GeneratedSlot {
  leadId: string;
  sendAt: Date; // absolute UTC instant
}

export type DeferReason =
  | "cap" // hit the inbox's daily cap
  | "domain_dedupe" // same corporate domain already mailed within 24h
  | "hourly_cap" // hit the inbox's per-hour ceiling
  | "window_overflow"; // no room left in today's send windows

export interface DeferredLead {
  leadId: string;
  reason: DeferReason;
}

export interface SlotOptions {
  windows?: SendWindow[];
  weekdayWeights?: Record<number, number>;
  rng?: Rng;
  // Median/min/max gap in minutes for the log-normal humanizer.
  gapMedianMin?: number;
  gapMinMin?: number;
  gapMaxMin?: number;
  // Chance per slot of a "coffee break" (skip 25-45 min).
  coffeeBreakChance?: number;
  // Account stagger offset in seconds so two inboxes never collide.
  accountStaggerSec?: number;
  // Domains already emailed within the last 24h from this account.
  recentDomains?: Set<string>;
  // Per-inbox ceiling on how many sends may fall in any single clock-hour
  // (lead-local). Undefined = no hourly ceiling.
  hourlyCap?: number;
  // Hard floor (minutes) between consecutive sends from this inbox. Overrides
  // gapMin upward when larger. Undefined = use gapMin.
  minGapMinutes?: number;
  // Days to skip besides zero-weight weekdays. Defaults to US federal holidays.
  isHoliday?: (dt: DateTime) => boolean;
}

/**
 * The next business DateTime at local midnight for a given tz, skipping
 * zero-weight weekdays and holidays. Starts from `fromDay`.
 */
function nextBusinessDay(
  fromDay: DateTime,
  weights: Record<number, number>,
  holiday: (dt: DateTime) => boolean,
): DateTime {
  let d = fromDay.startOf("day");
  for (let i = 0; i < 30; i++) {
    if (weekdayWeight(d.weekday, weights) > 0 && !holiday(d)) return d;
    d = d.plus({ days: 1 });
  }
  return d;
}

/**
 * Generate send slots for ONE account on ONE day.
 *
 * The algorithm:
 *  1. Respect domain dedupe (never 2 leads at same recipient domain within 24h).
 *  2. Distribute n across windows proportional to weight.
 *  3. Log-normal randomized gaps (median ~7m, min 3m, max 20m), sub-minute jitter.
 *  4. 10% chance per slot of a coffee break (25-45m).
 *  5. Caller staggers accounts (accountStaggerSec) so none send within 90s.
 *  6. Enqueue as delayed jobs (done by the worker, not here).
 *
 * `n` is the account's cold cap. Leads beyond dedupe/cap constraints are left
 * unscheduled (returned in `deferred`) for a future day.
 */
export function generateSlots(
  n: number,
  leads: SlotLead[],
  date: Date,
  tz: string,
  opts: SlotOptions = {},
): { slots: GeneratedSlot[]; deferred: SlotLead[]; deferredReasons: DeferredLead[] } {
  const windows = opts.windows ?? DEFAULT_WINDOWS;
  const weights = opts.weekdayWeights ?? DEFAULT_WEEKDAY_WEIGHTS;
  const rng = opts.rng ?? Math.random;
  const gapMedian = opts.gapMedianMin ?? 7;
  // A per-inbox minimum-gap setting (if any) raises the floor.
  const gapMin = Math.max(opts.gapMinMin ?? 3, opts.minGapMinutes ?? 0);
  const gapMax = Math.max(opts.gapMaxMin ?? 20, gapMin);
  const coffeeChance = opts.coffeeBreakChance ?? 0.1;
  const staggerSec = opts.accountStaggerSec ?? 0;
  const hourlyCap = opts.hourlyCap && opts.hourlyCap > 0 ? opts.hourlyCap : Infinity;
  const recentDomains = new Set(opts.recentDomains ?? []);

  const deferred: SlotLead[] = [];
  const deferredReasons: DeferredLead[] = [];
  const defer = (l: SlotLead, reason: DeferReason) => {
    deferred.push(l);
    deferredReasons.push({ leadId: l.leadId, reason });
  };

  // (1) domain dedupe + cap. Freemail domains (gmail/yahoo/...) are exempt:
  // consumer lists are mostly freemail, so deduping them would throttle each
  // inbox to a single lead per provider per day. Only corporate domains dedupe.
  const chosen: SlotLead[] = [];
  const seenDomains = new Set<string>(recentDomains);
  for (const l of leads) {
    if (chosen.length >= n) {
      defer(l, "cap");
      continue;
    }
    const dedupeDomain = !isFreemail(l.domain);
    if (dedupeDomain && seenDomains.has(l.domain)) {
      defer(l, "domain_dedupe");
      continue;
    }
    if (dedupeDomain) seenDomains.add(l.domain);
    chosen.push(l);
  }
  if (chosen.length === 0) return { slots: [], deferred, deferredReasons };

  // Resolve the business day in the *lead* timezone. The planner runs in the
  // early UTC morning, which is the *previous* evening in US timezones — so
  // "today" local has usually already passed its send windows. Plan for the
  // first business day whose windows are still entirely in the future to avoid
  // firing a whole day's emails at once the moment the planner runs.
  const localNow = DateTime.fromJSDate(date, { zone: tz });
  const firstWindowStartMin = windows.reduce(
    (m, w) => Math.min(m, w.startMin),
    Infinity,
  );
  const minutesIntoDay = localNow.hour * 60 + localNow.minute;
  let startDay = localNow.startOf("day");
  // If today's earliest window has already begun, roll to tomorrow so we never
  // schedule into a window that's partially (or fully) in the past.
  if (minutesIntoDay >= firstWindowStartMin) {
    startDay = startDay.plus({ days: 1 });
  }
  const baseDay = nextBusinessDay(startDay, weights, opts.isHoliday ?? isHoliday);

  // (2) distribute across windows proportional to weight
  const totalWeight = windows.reduce((s, w) => s + w.weight, 0);
  const perWindow: number[] = windows.map((w) =>
    Math.floor((chosen.length * w.weight) / totalWeight),
  );
  // Assign remainder to the heaviest windows.
  let assigned = perWindow.reduce((s, x) => s + x, 0);
  const order = windows
    .map((w, i) => ({ i, weight: w.weight }))
    .sort((a, b) => b.weight - a.weight);
  let oi = 0;
  while (assigned < chosen.length) {
    perWindow[order[oi % order.length]!.i]!++;
    assigned++;
    oi++;
  }

  // (3)(4) walk each window filling slots with log-normal gaps + coffee breaks
  const slots: GeneratedSlot[] = [];
  let leadIdx = 0;
  // Per clock-hour (minutes-from-midnight / 60) send counts, for hourlyCap.
  const perHour = new Map<number, number>();
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi]!;
    const count = perWindow[wi]!;
    if (count === 0) continue;

    // Start somewhere in the first ~15% of the window so we don't always begin
    // exactly at the edge.
    const windowSpanMin = w.endMin - w.startMin;
    let cursorMin = w.startMin + rng() * Math.min(15, windowSpanMin * 0.15);

    // Adaptive gap: spread `count` emails across the window's span so the pace
    // scales with the cold cap. Fewer emails -> larger gaps (spread over the day);
    // more emails -> tighter gaps, down to the gapMin floor. The fixed
    // gapMedian/gapMax act only as floor/ceiling bounds.
    const evenSpacing = windowSpanMin / Math.max(1, count);
    // Even spacing across the window, but never tighter than the gapMin floor.
    const adaptiveMedian = Math.max(gapMin, evenSpacing);
    // Allow occasional longer pauses proportional to the spacing.
    const adaptiveMax = Math.max(gapMax, adaptiveMedian * 2.5);

    for (let k = 0; k < count && leadIdx < chosen.length; k++) {
      // Coffee break before this slot?
      if (k > 0 && rng() < coffeeChance) {
        cursorMin += 25 + rng() * 20; // 25-45 min
      }
      // Clamp inside the window; if we overflow, spill remaining to next window
      // by breaking (they'll be picked up as deferred to next day if truly no room).
      if (cursorMin > w.endMin) break;

      // Per-inbox hourly ceiling: if this clock-hour is full, jump the cursor
      // to the top of the next hour and re-check the window bound.
      if (hourlyCap !== Infinity) {
        let hourBucket = Math.floor(cursorMin / 60);
        while ((perHour.get(hourBucket) ?? 0) >= hourlyCap) {
          cursorMin = (hourBucket + 1) * 60;
          hourBucket = Math.floor(cursorMin / 60);
          if (cursorMin > w.endMin) break;
        }
        if (cursorMin > w.endMin) break;
        perHour.set(hourBucket, (perHour.get(hourBucket) ?? 0) + 1);
      }

      const secJitter = Math.floor(rng() * 60); // never round times
      const localSlot = baseDay.plus({
        minutes: Math.floor(cursorMin),
        seconds: (Math.round((cursorMin % 1) * 60) + secJitter) % 60 + staggerSec,
      });

      slots.push({
        leadId: chosen[leadIdx]!.leadId,
        sendAt: localSlot.toUTC().toJSDate(),
      });
      leadIdx++;

      // (3) advance cursor by a log-normal gap centred on the adaptive spacing
      cursorMin += logNormalGap(rng, adaptiveMedian, gapMin, adaptiveMax);
    }
  }

  // Any chosen leads we couldn't fit (windows/hours overflowed) defer to next day.
  for (; leadIdx < chosen.length; leadIdx++) {
    defer(chosen[leadIdx]!, "window_overflow");
  }

  // Ensure monotonic ordering across all windows before returning.
  slots.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  return { slots, deferred, deferredReasons };
}
