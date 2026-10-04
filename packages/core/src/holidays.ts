import { DateTime } from "luxon";

/**
 * US federal holidays (observed). Static generator so we don't need a lib.
 * Returns a Set of ISO dates (yyyy-MM-dd) for the given year, using the
 * federal "observed" rule (Sat -> Fri, Sun -> Mon).
 */

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number, // 1=Mon..7=Sun (luxon)
  n: number,
): DateTime {
  let dt = DateTime.fromObject({ year, month, day: 1 });
  let count = 0;
  while (true) {
    if (dt.weekday === weekday) {
      count++;
      if (count === n) return dt;
    }
    dt = dt.plus({ days: 1 });
  }
}

function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): DateTime {
  let dt = DateTime.fromObject({ year, month, day: 1 }).endOf("month").startOf("day");
  while (dt.weekday !== weekday) dt = dt.minus({ days: 1 });
  return dt;
}

function observed(dt: DateTime): DateTime {
  if (dt.weekday === 6) return dt.minus({ days: 1 }); // Sat -> Fri
  if (dt.weekday === 7) return dt.plus({ days: 1 }); // Sun -> Mon
  return dt;
}

const cache = new Map<number, Set<string>>();

export function usFederalHolidays(year: number): Set<string> {
  const cached = cache.get(year);
  if (cached) return cached;

  const fixed = [
    observed(DateTime.fromObject({ year, month: 1, day: 1 })), // New Year's
    observed(DateTime.fromObject({ year, month: 6, day: 19 })), // Juneteenth
    observed(DateTime.fromObject({ year, month: 7, day: 4 })), // Independence Day
    observed(DateTime.fromObject({ year, month: 11, day: 11 })), // Veterans Day
    observed(DateTime.fromObject({ year, month: 12, day: 25 })), // Christmas
  ];
  const floating = [
    nthWeekdayOfMonth(year, 1, 1, 3), // MLK — 3rd Mon Jan
    nthWeekdayOfMonth(year, 2, 1, 3), // Washington's Bday — 3rd Mon Feb
    lastWeekdayOfMonth(year, 5, 1), // Memorial — last Mon May
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor — 1st Mon Sep
    nthWeekdayOfMonth(year, 10, 1, 2), // Columbus — 2nd Mon Oct
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving — 4th Thu Nov
  ];

  const set = new Set<string>(
    [...fixed, ...floating].map((d) => d.toISODate()!),
  );
  cache.set(year, set);
  return set;
}

export function isHoliday(dt: DateTime): boolean {
  return usFederalHolidays(dt.year).has(dt.toISODate()!);
}

/** Which holiday calendar the planner skips. "none" sends on every weighted weekday. */
export type HolidayCalendar = "us" | "none";

export function holidayPredicate(calendar: HolidayCalendar): (dt: DateTime) => boolean {
  return calendar === "none" ? () => false : isHoliday;
}
