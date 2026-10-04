import { describe, it, expect } from "vitest";
import {
  computeCap,
  computeHealth,
  dailyBudget,
  healthMultiplier,
  rampFactor,
} from "../cap.js";

const mature = { accountAgeDays: 60 };

describe("healthMultiplier", () => {
  it("tiers correctly", () => {
    expect(healthMultiplier(95)).toBe(1.0);
    expect(healthMultiplier(90)).toBe(1.0);
    expect(healthMultiplier(89)).toBe(0.6);
    expect(healthMultiplier(70)).toBe(0.6);
    expect(healthMultiplier(69)).toBe(0.3);
    expect(healthMultiplier(50)).toBe(0.3);
    expect(healthMultiplier(49)).toBe(0);
  });
});

describe("rampFactor", () => {
  it("ramps a new inbox", () => {
    expect(rampFactor(1)).toBe(0.3);
    expect(rampFactor(7)).toBe(0.3);
    expect(rampFactor(8)).toBe(0.5);
    expect(rampFactor(14)).toBe(0.5);
    expect(rampFactor(15)).toBe(0.75);
    expect(rampFactor(21)).toBe(0.75);
    expect(rampFactor(22)).toBe(1.0);
  });
});

describe("computeCap", () => {
  it("worked example: 25 base, 15 warmup, healthy, mature -> 25", () => {
    const cap = computeCap({
      capColdBase: 25,
      warmupVolumeManual: 15,
      healthScore: 95,
      ...mature,
    });
    expect(cap).toBe(25); // min(25, 40-15)=25
  });

  it("warmup priority shrinks cold so combined <= 40", () => {
    const warmup = 30;
    const cap = computeCap({
      capColdBase: 25,
      warmupVolumeManual: warmup,
      healthScore: 95,
      ...mature,
    });
    expect(cap).toBe(10); // 40-30
    expect(cap + warmup).toBeLessThanOrEqual(40);
  });

  it("quarantine health => 0 cold", () => {
    expect(
      computeCap({
        capColdBase: 25,
        warmupVolumeManual: 15,
        healthScore: 40,
        ...mature,
      }),
    ).toBe(0);
  });

  it("new inbox ramp reduces cap", () => {
    const cap = computeCap({
      capColdBase: 25,
      warmupVolumeManual: 15,
      healthScore: 95,
      accountAgeDays: 3,
    });
    expect(cap).toBe(7); // floor(25 * 0.3)
  });
});

describe("dailyBudget", () => {
  it("4 healthy inboxes cap at global ceiling 100", () => {
    const accts = Array.from({ length: 4 }, () => ({
      capColdBase: 25,
      warmupVolumeManual: 15,
      healthScore: 95,
      ...mature,
    }));
    expect(dailyBudget(accts)).toBe(100); // min(100, 4*25)
  });
});

describe("computeHealth", () => {
  it("perfect account is 100", () => {
    expect(
      computeHealth({
        bounceRate7d: 0,
        gmailErrRate7d: 0,
        replyRate7d: 0,
        dnsblListed: false,
        spfDkimDmarcFail: false,
      }),
    ).toBe(100);
  });

  it("high bounce + dnsbl tanks the score", () => {
    const h = computeHealth({
      bounceRate7d: 0.05,
      gmailErrRate7d: 0,
      replyRate7d: 0,
      dnsblListed: true,
      spfDkimDmarcFail: false,
    });
    expect(h).toBe(55); // 100 -30 -15
  });

  it("reply engagement adds a capped bonus", () => {
    const h = computeHealth({
      bounceRate7d: 0.05,
      gmailErrRate7d: 0,
      replyRate7d: 0.10,
      dnsblListed: false,
      spfDkimDmarcFail: false,
    });
    expect(h).toBe(80); // 100 -30 +10(capped)
  });
});
