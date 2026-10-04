/**
 * Geographic lead-selection filters for campaigns, in one place.
 *
 * The same rules have to hold in three places — the API's eligible-lead
 * preview and the daily planner's two selection queries — or the count shown
 * before launch won't match what actually sends. Keeping the logic here means
 * they can't drift apart.
 *
 * Stored on `Campaign.filtersJson`, so adding keys needs no migration.
 *
 * Supported keys, all optional:
 *   city       string    legacy single city (still honoured; older campaigns
 *                        created before multi-select rely on it)
 *   cities     string[]  any of these cities
 *   timezones  string[]  any of these IANA zones
 *   state      string    exact state code
 *
 * City and timezone combine with AND: `cities: ["Springfield"]` plus
 * `timezones: ["America/New_York"]` means leads in Springfield that are also on
 * Eastern time. Each key on its own filters only on that key.
 *
 * Returns plain condition objects rather than Prisma types so this module
 * stays dependency-free; call sites cast to Prisma.LeadWhereInput[].
 */
export type LeadFilterCondition = Record<string, unknown>;

export function leadGeoConditions(
  filters: Record<string, unknown> | null | undefined,
): LeadFilterCondition[] {
  const f = filters ?? {};
  const conditions: LeadFilterCondition[] = [];

  // Cities: merge the legacy single `city` with the newer `cities` array, then
  // match case-insensitively. An explicit OR of equals rather than `in`, because
  // insensitive matching on `in` is not reliable across Prisma versions.
  const cityList: string[] = [];
  if (typeof f.city === "string" && f.city.trim()) cityList.push(f.city.trim());
  if (Array.isArray(f.cities))
    for (const c of f.cities) if (typeof c === "string" && c.trim()) cityList.push(c.trim());
  const uniqueCities = [...new Set(cityList.map((c) => c.toLowerCase()))].map(
    (lower) => cityList.find((c) => c.toLowerCase() === lower)!,
  );
  if (uniqueCities.length === 1)
    conditions.push({ city: { equals: uniqueCities[0], mode: "insensitive" } });
  else if (uniqueCities.length > 1)
    conditions.push({
      OR: uniqueCities.map((c) => ({ city: { equals: c, mode: "insensitive" } })),
    });

  // Timezones: exact IANA strings, so a plain `in` is correct here.
  const tzList = Array.isArray(f.timezones)
    ? [...new Set(f.timezones.filter((t): t is string => typeof t === "string" && !!t.trim()))]
    : [];
  if (tzList.length) conditions.push({ timezone: { in: tzList } });

  if (typeof f.state === "string" && f.state.trim()) conditions.push({ state: f.state.trim() });

  return conditions;
}
