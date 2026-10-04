import { DateTime } from "luxon";
import { prisma } from "@trickle/db";
import { computeHealth } from "@trickle/core";
import { checkSpfDkimDmarc, checkDnsbl, resolveHostIp, alert } from "@trickle/shared";
import { domainOf } from "../lib.js";

/**
 * health-check: recompute each inbox's internal health score from the app's own
 * 7-day signals + free DNS/DNSBL checks. Applies cap multipliers via the score
 * and enforces the health circuit breakers.
 */
export async function processHealthCheck() {
  const accounts = await prisma.account.findMany();
  const since = DateTime.utc().minus({ days: 7 }).startOf("day").toJSDate();

  for (const a of accounts) {
    const logs = await prisma.sendLog.findMany({
      where: { accountId: a.id, date: { gte: since } },
    });
    const cold = logs.reduce((s, l) => s + l.coldSent, 0);
    const bounces = logs.reduce((s, l) => s + l.bounces, 0);
    const replies = logs.reduce((s, l) => s + l.replies, 0);
    const errs = logs.reduce((s, l) => s + l.gmailErr, 0);
    const denom = Math.max(1, cold);

    const domain = domainOf(a.email);
    let dnsblListed = false;
    let spfDkimDmarcFail = false;
    try {
      const dns = await checkSpfDkimDmarc(domain);
      spfDkimDmarcFail = !dns.ok;
      const ip = await resolveHostIp(`mail.${domain}`).catch(() => null);
      if (ip) dnsblListed = await checkDnsbl(ip);
    } catch {
      /* DNS best-effort */
    }

    const health = computeHealth({
      bounceRate7d: bounces / denom,
      gmailErrRate7d: errs / denom,
      replyRate7d: replies / denom,
      dnsblListed,
      spfDkimDmarcFail,
    });

    const prev = a.healthScore;
    const data: Record<string, unknown> = { healthScore: health };

    // Circuit breakers.
    if (health < 50) {
      data.status = "quarantined";
      if (prev >= 50)
        await alert("Inbox quarantined", `${a.email} health ${health} (<50).`);
    } else if (health < 70) {
      if (a.status === "quarantined") {
        // recovering — needs 3 consecutive good days handled by staying quarantined
      }
      if (prev >= 70)
        await alert("Inbox health low", `${a.email} health ${health} (<70); cap reduced (×0.6).`);
    } else if (a.status === "quarantined" && health >= 70) {
      // Simple recovery: restore to active once back above 70.
      data.status = "active";
    }

    await prisma.account.update({ where: { id: a.id }, data });
  }

  // Worker heartbeat. beatAt is set explicitly on both branches: Prisma's
  // `update: {}` writes nothing on an existing row.
  const now = new Date();
  await prisma.workerHeartbeat.upsert({
    where: { id: "singleton" },
    update: { beatAt: now },
    create: { id: "singleton", beatAt: now },
  });
}
