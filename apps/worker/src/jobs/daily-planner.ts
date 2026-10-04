import { DateTime } from "luxon";
import { prisma, Prisma, Lead, Campaign, Variant } from "@trickle/db";
import {
  planDay,
  renderTemplate,
  leadGeoConditions,
  leadMergeVars,
  holidayPredicate,
  PlannerAccount,
  PlannerLead,
} from "@trickle/core";
import { env, sendQueue } from "@trickle/shared";
import {
  capConfig,
  toCapAccount,
  recentDomains,
  domainOf,
  usageToday,
  accountWindows,
} from "../lib.js";

/**
 * daily-planner. Runs 00:05 UTC (repeatable) and right after a campaign launch.
 * Builds the day's send plan: due follow-ups first, then new campaign leads,
 * assigns each lead to its sending account (round-robin, then sticky),
 * generates humanized slots, and enqueues delayed BullMQ send jobs.
 *
 * Follow-up Message rows are created (status=planned, stepIndex>0) by the
 * send-email job after the prior step sends; here we just slot the ones due.
 */
export async function runDailyPlanner(forDate = new Date()) {
  const cfg = capConfig();
  const nowDate = new Date();

  // Promote scheduled campaigns whose start time has arrived to running.
  await prisma.campaign.updateMany({
    where: { status: "scheduled", scheduledStartAt: { lte: nowDate } },
    data: { status: "running" },
  });

  // Domain blocklist (broader than exact-email suppression).
  const blocked = new Set(
    (await prisma.blocklist.findMany({ select: { domain: true } })).map((b) => b.domain),
  );

  const accounts = await prisma.account.findMany({
    where: {
      status: "active",
      OR: [{ pausedUntil: null }, { pausedUntil: { lt: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
  });
  if (accounts.length === 0) {
    await prisma.event.create({ data: { type: "planner_noaccounts", payload: {} } });
    return { scheduled: 0, budget: 0 };
  }

  const plannerAccounts: PlannerAccount[] = [];
  for (const a of accounts) {
    const usage = await usageToday(a.id);
    plannerAccounts.push({
      ...toCapAccount(a),
      recentDomains: await recentDomains(a.id),
      // Idempotent cap: never exceed the daily limit across re-plans.
      sentToday: usage.sent,
      outstandingToday: usage.outstanding,
      // Per-inbox scheduling overrides (null columns => undefined => defaults).
      sendWindows: accountWindows(a),
      hourlyCap: a.hourlyCap ?? undefined,
      minGapMinutes: a.minGapMinutes ?? undefined,
    });
  }

  const leadsByAccount = new Map<string, PlannerLead[]>();
  for (const a of accounts) leadsByAccount.set(a.id, []);

  // Existing planned messages that are due -> reschedule these rows. Covers
  // follow-ups (stepIndex > 0) AND initial sends reset to `planned` by a
  // campaign pause; only running campaigns (a paused campaign's rows must
  // stay dormant until resume).
  const followUpMsgId = new Map<string, string>(); // leadId -> messageId
  const dueFollowUps = await prisma.message.findMany({
    where: {
      direction: "out",
      status: "planned",
      scheduledAt: { lte: DateTime.fromJSDate(forDate).endOf("day").toJSDate() },
      OR: [{ campaignId: null }, { campaign: { status: "running" } }],
    },
    include: { lead: true },
  });
  for (const fu of dueFollowUps) {
    // Skip snoozed leads and blocklisted domains.
    if (fu.lead.snoozeUntil && fu.lead.snoozeUntil > nowDate) continue;
    if (blocked.has(domainOf(fu.lead.email))) continue;
    // Orphaned follow-up (its inbox was deleted) — cannot be slotted.
    if (!fu.accountId) continue;
    leadsByAccount.get(fu.accountId)?.unshift({
      leadId: fu.leadId,
      timezone: fu.lead.timezone,
      domain: domainOf(fu.lead.email),
      accountId: fu.accountId,
    });
    followUpMsgId.set(fu.leadId, fu.id);
  }

  // New initial sends from running campaigns.
  const initialIntent = new Map<
    string,
    { lead: Lead; campaign: Campaign; variant: Variant }
  >();
  const runningCampaigns = await prisma.campaign.findMany({ where: { status: "running" } });

  let rr = 0;
  for (const campaign of runningCampaigns) {
    const where: Prisma.LeadWhereInput = {
      status: "pending",
      messages: { none: { campaignId: campaign.id, direction: "out" } },
    };
    if (campaign.regionId) where.regionId = campaign.regionId;
    const filters = (campaign.filtersJson ?? {}) as Record<string, unknown>;
    const geo = leadGeoConditions(filters) as Prisma.LeadWhereInput[];
    if (geo.length) where.AND = geo;

    const leads = await prisma.lead.findMany({
      where,
      take: cfg.globalCeiling * 5,
      orderBy: { createdAt: "asc" },
    });

    for (const lead of leads) {
      const supp = await prisma.suppression.findUnique({ where: { email: lead.email } });
      if (supp) continue;
      // Respect manual snooze and the domain blocklist.
      if (lead.snoozeUntil && lead.snoozeUntil > nowDate) continue;
      if (blocked.has(domainOf(lead.email))) continue;

      let accountId = lead.accountId;
      if (!accountId) {
        accountId = accounts[rr % accounts.length]!.id;
        rr++;
        await prisma.lead.update({ where: { id: lead.id }, data: { accountId } });
      }
      // Only assign variant B when A/B is enabled AND B copy actually exists;
      // otherwise we'd send A's copy but mislabel it "B" and skew A/B data.
      const hasVariantB = !!(campaign.subjectVariantB || campaign.bodyVariantB);
      const variant: Variant =
        campaign.abEnabled && hasVariantB && Math.random() < 0.5 ? "B" : "A";
      leadsByAccount.get(accountId)?.push({
        leadId: lead.id,
        timezone: lead.timezone,
        domain: domainOf(lead.email),
        accountId,
      });
      initialIntent.set(lead.id, { lead, campaign, variant });
    }
  }

  // Per-campaign send-window override.
  // Applied as the default window set when exactly one running campaign defines
  // it; per-inbox `sendWindows` still take precedence inside the planner.
  let campaignWindows: { startMin: number; endMin: number; weight: number }[] | undefined;
  const withWindows = runningCampaigns.filter(
    (c) => Array.isArray(c.sendWindowsJson) && (c.sendWindowsJson as unknown[]).length,
  );
  if (withWindows.length === 1) {
    const raw = withWindows[0]!.sendWindowsJson as unknown[];
    const parsed = raw
      .filter(
        (w: any) =>
          w &&
          typeof w.startMin === "number" &&
          typeof w.endMin === "number" &&
          typeof w.weight === "number" &&
          w.endMin > w.startMin,
      )
      .map((w: any) => ({ startMin: w.startMin, endMin: w.endMin, weight: w.weight }));
    if (parsed.length) campaignWindows = parsed;
  }

  const plan = planDay(forDate, plannerAccounts, leadsByAccount, {
    capConfig: cfg,
    accountStaggerStepSec: 95,
    slotOptions: {
      isHoliday: holidayPredicate(env.holidayCalendar()),
      ...(campaignWindows ? { windows: campaignWindows } : {}),
    },
  });

  let scheduled = 0;
  const now = Date.now();
  for (const asg of plan.assignments) {
    for (const slot of asg.slots) {
      const delay = Math.max(0, slot.sendAt.getTime() - now);
      const fuId = followUpMsgId.get(slot.leadId);

      if (fuId) {
        const job = await sendQueue.add(
          "send-email",
          { messageId: fuId },
          { delay, removeOnComplete: true },
        );
        await prisma.message.update({
          where: { id: fuId },
          data: { scheduledAt: slot.sendAt, status: "queued", bulljobId: job.id },
        });
        scheduled++;
        continue;
      }

      const init = initialIntent.get(slot.leadId);
      if (!init) continue;
      const { lead, campaign, variant } = init;
      const vars = leadMergeVars(lead);
      const subjTpl =
        variant === "B" && campaign.subjectVariantB
          ? campaign.subjectVariantB
          : campaign.subjectTemplate;
      const bodyTpl =
        variant === "B" && campaign.bodyVariantB
          ? campaign.bodyVariantB
          : campaign.bodyTemplate;

      const msg = await prisma.message.create({
        data: {
          direction: "out",
          status: "planned",
          variant,
          stepIndex: 0,
          subject: renderTemplate(subjTpl, vars),
          body: renderTemplate(bodyTpl, vars),
          scheduledAt: slot.sendAt,
          leadId: lead.id,
          campaignId: campaign.id,
          accountId: asg.accountId,
        },
      });
      const job = await sendQueue.add(
        "send-email",
        { messageId: msg.id },
        { delay, removeOnComplete: true },
      );
      await prisma.message.update({
        where: { id: msg.id },
        data: { bulljobId: job.id, status: "queued" },
      });
      scheduled++;
    }
  }

  // Mark campaigns done: no eligible pending leads left AND nothing still
  // planned/queued/in-flight. Otherwise a finished campaign stays "running"
  // forever and is re-scanned every night.
  let completed = 0;
  for (const campaign of runningCampaigns) {
    const remainingWhere: Prisma.LeadWhereInput = {
      status: "pending",
      messages: { none: { campaignId: campaign.id, direction: "out" } },
    };
    if (campaign.regionId) remainingWhere.regionId = campaign.regionId;
    const filters = (campaign.filtersJson ?? {}) as Record<string, unknown>;
    const remainingGeo = leadGeoConditions(filters) as Prisma.LeadWhereInput[];
    if (remainingGeo.length) remainingWhere.AND = remainingGeo;

    const [remaining, outstanding] = await Promise.all([
      prisma.lead.count({ where: remainingWhere }),
      prisma.message.count({
        where: {
          campaignId: campaign.id,
          direction: "out",
          status: { in: ["planned", "queued"] },
        },
      }),
    ]);
    if (remaining === 0 && outstanding === 0) {
      await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "done" } });
      completed++;
    }
  }

  await prisma.event.create({
    data: {
      type: "planner_run",
      payload: {
        date: forDate.toISOString(),
        scheduled,
        completed,
        budget: plan.dailyBudget,
        deferredByReason: plan.deferredByReason,
      },
    },
  });
  return { scheduled, completed, budget: plan.dailyBudget };
}
