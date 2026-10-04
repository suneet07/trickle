import { describe, it, expect } from "vitest";
import { leadGeoConditions } from "../leadFilters.js";

describe("leadGeoConditions", () => {
  it("empty filters produce no conditions (campaign sends to everyone, as before)", () => {
    expect(leadGeoConditions({})).toEqual([]);
    expect(leadGeoConditions(null)).toEqual([]);
  });
  it("legacy single city matches the old where-clause exactly", () => {
    expect(leadGeoConditions({ city: "Springfield" })).toEqual([
      { city: { equals: "Springfield", mode: "insensitive" } },
    ]);
  });
  it("legacy city plus state behaves as before", () => {
    expect(leadGeoConditions({ city: "Springfield", state: "IL" })).toEqual([
      { city: { equals: "Springfield", mode: "insensitive" } },
      { state: "IL" },
    ]);
  });
  it("multiple cities become an OR", () => {
    expect(leadGeoConditions({ cities: ["Springfield", "Riverside"] })).toEqual([
      { OR: [
        { city: { equals: "Springfield", mode: "insensitive" } },
        { city: { equals: "Riverside", mode: "insensitive" } },
      ] },
    ]);
  });
  it("legacy city merges with cities without duplicating", () => {
    const r = leadGeoConditions({ city: "Springfield", cities: ["springfield", "Riverside"] });
    expect(r).toHaveLength(1);
    expect((r[0] as any).OR).toHaveLength(2);
  });
  it("timezones filter on their own", () => {
    expect(leadGeoConditions({ timezones: ["America/New_York"] })).toEqual([
      { timezone: { in: ["America/New_York"] } },
    ]);
  });
  it("city and timezone combine as separate AND conditions", () => {
    expect(leadGeoConditions({ cities: ["Springfield"], timezones: ["America/New_York"] })).toEqual([
      { city: { equals: "Springfield", mode: "insensitive" } },
      { timezone: { in: ["America/New_York"] } },
    ]);
  });
  it("ignores junk values instead of building a filter that matches nothing", () => {
    expect(leadGeoConditions({ cities: ["", "  "], timezones: [], city: "" })).toEqual([]);
  });
});
