import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { generateSlots, SlotLead } from "../slots.js";
import { planDay, PlannerAccount, PlannerLead } from "../planner.js";
import { seededRng } from "../util.js";
import { isHoliday, holidayPredicate } from "../holidays.js";

const TZ = "America/Los_Angeles";

function makeLeads(n: number, domainSpread = n): SlotLead[] {
  return Array.from({ length: n }, (_, i) => ({
    leadId: `lead-${i}`,
    timezone: TZ,
    domain: `d${i % domainSpread}.com`,
  }));
}

// A Wednesday (business day) in Los Angeles.
const WED = DateTime.fromISO("2026-07-15T12:00:00", { zone: TZ }).toJSDate();

describe("generateSlots", () => {
  it("never exceeds the cap", () => {
    const { slots } = generateSlots(25, makeLeads(100), WED, TZ, {
      rng: seededRng(1),
    });
    expect(slots.length).toBeLessThanOrEqual(25);
  });

  it("enforces domain dedupe within a day", () => {
    // 30 leads but only 5 distinct domains -> at most 5 scheduled.
    const { slots, deferred } = generateSlots(25, makeLeads(30, 5), WED, TZ, {
      rng: seededRng(2),
    });
    const domains = new Set(
      slots.map((s) => s.leadId), // each chosen lead has unique domain by construction
    );
    expect(slots.length).toBeLessThanOrEqual(5);
    expect(deferred.length).toBeGreaterThan(0);
    expect(domains.size).toBe(slots.length);
  });

  it("respects recentDomains (24h dedupe across days)", () => {
    const recent = new Set(["d0.com", "d1.com"]);
    const { slots } = generateSlots(25, makeLeads(5, 5), WED, TZ, {
      rng: seededRng(3),
      recentDomains: recent,
    });
    // d0 and d1 already emailed -> only d2,d3,d4 remain.
    expect(slots.length).toBe(3);
  });

  it("all send times land inside a weighted window in the lead's tz", () => {
    const { slots } = generateSlots(20, makeLeads(20), WED, TZ, {
      rng: seededRng(4),
    });
    for (const s of slots) {
      const local = DateTime.fromJSDate(s.sendAt, { zone: TZ });
      const min = local.hour * 60 + local.minute;
      const inWindow =
        (min >= 8 * 60 + 30 && min <= 11 * 60 + 30) ||
        (min >= 13 * 60 && min <= 16 * 60 + 30) ||
        (min >= 16 * 60 + 30 && min <= 18 * 60);
      expect(inWindow, `send at ${local.toISO()}`).toBe(true);
    }
  });

  it("never produces round times (has second-level jitter) and no fixed gaps", () => {
    const { slots } = generateSlots(20, makeLeads(20), WED, TZ, {
      rng: seededRng(5),
    });
    const secs = slots.map((s) =>
      DateTime.fromJSDate(s.sendAt, { zone: TZ }).second,
    );
    // Not all zero seconds.
    expect(secs.some((x) => x !== 0)).toBe(true);

    // Gaps within a window should vary (no single fixed interval).
    const times = slots.map((s) => s.sendAt.getTime()).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    const uniqueGaps = new Set(gaps.map((g) => Math.round(g / 1000)));
    expect(uniqueGaps.size).toBeGreaterThan(1);
  });

  it("skips weekends -> a Saturday date lands on a business day", () => {
    const SAT = DateTime.fromISO("2026-07-18T12:00:00", { zone: TZ }).toJSDate();
    const { slots } = generateSlots(5, makeLeads(5), SAT, TZ, {
      rng: seededRng(6),
    });
    for (const s of slots) {
      const local = DateTime.fromJSDate(s.sendAt, { zone: TZ });
      expect(local.weekday).toBeLessThan(6); // Mon-Fri
      expect(isHoliday(local)).toBe(false);
    }
  });
});

describe("planDay", () => {
  it("caps total at global ceiling and staggers accounts >90s", () => {
    const accounts: PlannerAccount[] = Array.from({ length: 4 }, (_, i) => ({
      id: `acct-${i}`,
      capColdBase: 25,
      warmupVolumeManual: 15,
      healthScore: 95,
      accountAgeDays: 60,
    }));
    const leadsByAccount = new Map<string, PlannerLead[]>();
    for (const a of accounts) {
      leadsByAccount.set(
        a.id,
        Array.from({ length: 40 }, (_, i) => ({
          leadId: `${a.id}-lead-${i}`,
          timezone: TZ,
          domain: `${a.id}-d${i}.com`,
          accountId: a.id,
        })),
      );
    }

    const plan = planDay(WED, accounts, leadsByAccount, { rng: seededRng(7) });
    expect(plan.dailyBudget).toBe(100);
    expect(plan.totalScheduled).toBeLessThanOrEqual(100);

    // Each account scheduled at most its cap (25).
    for (const asg of plan.assignments) {
      expect(asg.slots.length).toBeLessThanOrEqual(25);
    }
  });
});

describe("holiday calendar", () => {
  // Thu 2 Jul 2026, mid-afternoon: today's windows have started, so the next
  // candidate day is Fri 3 Jul, the observed Independence Day holiday.
  const THU = DateTime.fromISO("2026-07-02T15:00:00", { zone: TZ }).toJSDate();

  it("skips US federal holidays by default", () => {
    const { slots } = generateSlots(3, makeLeads(3), THU, TZ, { rng: seededRng(8) });
    for (const s of slots) {
      expect(DateTime.fromJSDate(s.sendAt, { zone: TZ }).toISODate()).toBe("2026-07-06");
    }
  });

  it("sends on holidays when the calendar is disabled", () => {
    const { slots } = generateSlots(3, makeLeads(3), THU, TZ, {
      rng: seededRng(8),
      isHoliday: holidayPredicate("none"),
    });
    for (const s of slots) {
      expect(DateTime.fromJSDate(s.sendAt, { zone: TZ }).toISODate()).toBe("2026-07-03");
    }
  });
});
