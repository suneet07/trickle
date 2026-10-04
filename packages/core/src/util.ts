export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Consumer/free email providers. These are excluded from 24h domain dedupe:
 * lists of small businesses and individuals are overwhelmingly @gmail.com /
 * @yahoo.com, so deduping by domain would throttle each inbox to one gmail
 * lead per day. Only genuine corporate domains should dedupe.
 */
export const FREEMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "sbcglobal.net",
  "verizon.net",
  "att.net",
  "cox.net",
  "charter.net",
  "bellsouth.net",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
]);

export function isFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Deterministic-if-seeded PRNG (mulberry32). The planner accepts an injected
 * rng so tests are reproducible; production passes Math.random.
 */
export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample from a log-normal distribution via Box-Muller, clamped to [min,max]. */
export function logNormalGap(
  rng: Rng,
  medianMin: number,
  minMin: number,
  maxMin: number,
  sigma = 0.5,
): number {
  // median of log-normal = exp(mu)  => mu = ln(median)
  const mu = Math.log(medianMin);
  // Box-Muller for standard normal
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const sample = Math.exp(mu + sigma * z);
  return clamp(sample, minMin, maxMin);
}
