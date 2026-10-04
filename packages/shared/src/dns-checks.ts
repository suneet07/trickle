import { promises as dns } from "node:dns";

/** Free DNS + DNSBL checks used by the health engine (no paid API). */

export async function checkSpfDkimDmarc(domain: string): Promise<{
  spf: boolean;
  dmarc: boolean;
  ok: boolean;
}> {
  let spf = false;
  let dmarc = false;
  try {
    const txt = await dns.resolveTxt(domain);
    spf = txt.some((chunks) => chunks.join("").toLowerCase().startsWith("v=spf1"));
  } catch {
    /* no TXT */
  }
  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`);
    dmarc = txt.some((chunks) => chunks.join("").toLowerCase().startsWith("v=dmarc1"));
  } catch {
    /* no DMARC */
  }
  // DKIM selectors vary per provider; we can't enumerate them blindly, so we
  // report spf+dmarc and treat DKIM as verified out-of-band. ok = spf && dmarc.
  return { spf, dmarc, ok: spf && dmarc };
}

/** Reverse an IPv4 for DNSBL query. */
function reverseIp(ip: string): string {
  return ip.split(".").reverse().join(".");
}

/**
 * Query free DNS blacklists for a sending IP. Returns true if listed on any.
 * (Spamhaus zen, SORBS — free for low-volume lookups.)
 */
export async function checkDnsbl(ip: string): Promise<boolean> {
  const zones = ["zen.spamhaus.org", "dnsbl.sorbs.net"];
  const rev = reverseIp(ip);
  for (const zone of zones) {
    try {
      const res = await dns.resolve4(`${rev}.${zone}`);
      if (res.length > 0) return true; // any A record = listed
    } catch {
      /* NXDOMAIN = not listed */
    }
  }
  return false;
}

/** Resolve the A record of a hostname (best-effort). */
export async function resolveHostIp(host: string): Promise<string | null> {
  try {
    const [ip] = await dns.resolve4(host);
    return ip ?? null;
  } catch {
    return null;
  }
}
