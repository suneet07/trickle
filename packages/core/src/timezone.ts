/**
 * Static US state -> IANA timezone map, used when an import has a State column
 * but no explicit timezone.
 * Split-timezone states resolve to their majority/most-populous zone by default;
 * callers may refine by zip prefix via zipToTimezone().
 */
export const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix", // no DST
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York", // panhandle is Central; refine by zip
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise", // north is Pacific
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York", // west is Central
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago", // west is Mountain
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago", // west is Mountain
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles", // eastern sliver Mountain
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago", // west is Mountain
  TN: "America/Chicago", // east is Eastern
  TX: "America/Chicago", // far west (El Paso) Mountain
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
  DC: "America/New_York",
};

/**
 * Zip-prefix overrides for the largest split-timezone edge cases.
 * Keyed by 3-digit zip prefix -> IANA tz. Extend as needed.
 */
const ZIP_TZ_OVERRIDE: Record<string, string> = {
  // West TX / El Paso -> Mountain
  "799": "America/Denver",
  "885": "America/Denver",
  // FL panhandle (Pensacola area) -> Central
  "324": "America/Chicago",
  "325": "America/Chicago",
  // North Idaho panhandle -> Pacific
  "838": "America/Los_Angeles",
};

/** Fallback zone when nothing on the lead identifies one. */
export const DEFAULT_LEAD_TIMEZONE = "America/Los_Angeles";

export function stateToTimezone(
  state?: string | null,
  fallback: string = DEFAULT_LEAD_TIMEZONE,
): string {
  if (!state) return fallback;
  return STATE_TZ[state.trim().toUpperCase()] ?? fallback;
}

export function resolveTimezone(
  state?: string | null,
  zip?: string | null,
  fallback: string = DEFAULT_LEAD_TIMEZONE,
): string {
  // Zip prefixes are only meaningful for US 5-digit codes.
  if (zip && /^\d{5}/.test(zip.trim())) {
    const p3 = zip.trim().slice(0, 3);
    if (ZIP_TZ_OVERRIDE[p3]) return ZIP_TZ_OVERRIDE[p3]!;
  }
  return stateToTimezone(state, fallback);
}

/** True when the runtime knows this IANA zone (a bogus zone never matches a send window). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
