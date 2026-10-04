import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, Prisma, LeadStatus } from "@trickle/db";
import {
  renderTemplate,
  estimateCompletionDays,
  computeCap,
  leadGeoConditions,
  seededRng,
  composeBody,
  leadMergeVars,
} from "@trickle/core";
import { env, cancelCampaignQueued, placementQueue, plannerQueue } from "@trickle/shared";
import crypto from "node:crypto";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";

const followUpSchema = z.array(
  z.object({
    dayOffset: z.number().int().min(1),
    subjectTemplate: z.string(),
    bodyTemplate: z.string(),
  }),
);

const campaignBody = z.object({
  name: z.string().min(1),
  regionId: z.string().nullable().optional(),
  subjectTemplate: z.string().min(1),
  bodyTemplate: z.string().min(1),
  subjectVariantB: z.string().nullable().optional(),
  bodyVariantB: z.string().nullable().optional(),
  abEnabled: z.boolean().optional(),
  followUps: followUpSchema.optional(),
  filters: z.record(z.any()).optional(),
  isHtml: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  unsubHeader: z.boolean().optional(),
  // null/omitted = default sig-block footer; "" = no footer; text = custom.
  footerOverride: z.string().nullable().optional(),
});

/**
 * Same shape as campaignBody but everything is optional and nothing has a
 * min-length — a live preview has to render a half-typed draft, so it must not
 * 400 just because the subject is still empty.
 */
const previewBody = z.object({
  id: z.string().optional(),
  regionId: z.string().nullable().optional(),
  subjectTemplate: z.string().optional(),
  bodyTemplate: z.string().optional(),
  subjectVariantB: z.string().nullable().optional(),
  bodyVariantB: z.string().nullable().optional(),
  abEnabled: z.boolean().optional(),
  followUps: followUpSchema.optional(),
  filters: z.record(z.any()).optional(),
  isHtml: z.boolean().optional(),
  footerOverride: z.string().nullable().optional(),
});

/** Sum of today's per-inbox caps, clamped by the global ceiling. */
function dailyBudgetFrom(
  accounts: {
    dailyCapCold: number;
    warmupVolumeManual: number;
    healthScore: number;
    warmedUp: boolean;
    createdAt: Date;
  }[],
): number {
  return Math.min(
    env.globalDailyCap(),
    accounts.reduce(
      (s, a) =>
        s +
        computeCap(
          {
            capColdBase: a.dailyCapCold,
            warmupVolumeManual: a.warmupVolumeManual,
            healthScore: a.healthScore,
            accountAgeDays: a.warmedUp
              ? 999
              : Math.max(0, Math.floor((Date.now() - a.createdAt.getTime()) / 86400000)),
          },
          { totalCap: env.perInboxTotalCap(), globalCeiling: env.globalDailyCap() },
        ),
      0,
    ),
  );
}

/**
 * Build the Prisma where-clause for a campaign's eligible leads. Mirrors the
 * daily-planner's selection so the preview count/ETA don't overstate reality:
 * excludes leads already messaged by this campaign and (optionally) suppressed
 * emails.
 */
export function eligibleLeadWhere(
  campaign: {
    id?: string;
    regionId: string | null;
    filtersJson: Prisma.JsonValue;
  },
  suppressedEmails?: string[],
): Prisma.LeadWhereInput {
  const filters = (campaign.filtersJson ?? {}) as Record<string, unknown>;
  const where: Prisma.LeadWhereInput = {
    status: (filters.status as LeadStatus) ?? "pending",
  };
  if (campaign.regionId) where.regionId = campaign.regionId;
  const geo = leadGeoConditions(filters) as Prisma.LeadWhereInput[];
  if (geo.length) where.AND = geo;
  if (campaign.id)
    where.messages = { none: { campaignId: campaign.id, direction: "out" } };
  if (suppressedEmails && suppressedEmails.length)
    where.email = { notIn: suppressedEmails };
  return where;
}

export default async function campaignRoutes(app: FastifyInstance) {
  app.get("/api/campaigns", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({ includeArchived: z.coerce.boolean().default(false) })
      .parse(req.query);
    const campaigns = await prisma.campaign.findMany({
      where: q.includeArchived ? {} : { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        region: { select: { name: true } },
        _count: { select: { messages: true } },
      },
    });
    return campaigns;
  });

  app.post("/api/campaigns", { preHandler: requireAuth }, async (req, reply) => {
    const body = campaignBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", detail: body.error.issues });
    const d = body.data;
    const campaign = await prisma.campaign.create({
      data: {
        name: d.name,
        regionId: d.regionId ?? null,
        subjectTemplate: d.subjectTemplate,
        bodyTemplate: d.bodyTemplate,
        subjectVariantB: d.subjectVariantB ?? null,
        bodyVariantB: d.bodyVariantB ?? null,
        abEnabled: d.abEnabled ?? false,
        followUpsJson: (d.followUps ?? []) as unknown as Prisma.InputJsonValue,
        filtersJson: (d.filters ?? {}) as Prisma.InputJsonValue,
        isHtml: d.isHtml ?? false,
        trackOpens: d.trackOpens ?? false,
        trackClicks: d.trackClicks ?? false,
        unsubHeader: d.unsubHeader ?? false,
        footerOverride: d.footerOverride ?? null,
      },
    });
    await audit("campaign.create", campaign.id, { name: campaign.name });
    return campaign;
  });

  app.put("/api/campaigns/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = campaignBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Lock copy/targeting edits while a campaign is actively sending — otherwise
    // edits silently affect only future days and confuse reporting. Pause first.
    const current = await prisma.campaign.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (current.status === "running") {
      return reply.code(409).send({
        error: "campaign_running",
        message: "Pause the campaign before editing it.",
      });
    }
    const d = body.data;
    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(d.isHtml != null ? { isHtml: d.isHtml } : {}),
        ...(d.trackOpens != null ? { trackOpens: d.trackOpens } : {}),
        ...(d.trackClicks != null ? { trackClicks: d.trackClicks } : {}),
        ...(d.unsubHeader != null ? { unsubHeader: d.unsubHeader } : {}),
        ...(d.footerOverride !== undefined ? { footerOverride: d.footerOverride } : {}),
        ...(d.name != null ? { name: d.name } : {}),
        ...(d.regionId !== undefined ? { regionId: d.regionId } : {}),
        ...(d.subjectTemplate != null ? { subjectTemplate: d.subjectTemplate } : {}),
        ...(d.bodyTemplate != null ? { bodyTemplate: d.bodyTemplate } : {}),
        ...(d.subjectVariantB !== undefined ? { subjectVariantB: d.subjectVariantB } : {}),
        ...(d.bodyVariantB !== undefined ? { bodyVariantB: d.bodyVariantB } : {}),
        ...(d.abEnabled != null ? { abEnabled: d.abEnabled } : {}),
        ...(d.followUps != null
          ? { followUpsJson: d.followUps as unknown as Prisma.InputJsonValue }
          : {}),
        ...(d.filters != null
          ? { filtersJson: d.filters as Prisma.InputJsonValue }
          : {}),
      },
    });
    return updated;
  });

  /**
   * Live pre-send preview. Unlike GET /:id/preview this takes an UNSAVED draft
   * in the body, so the editor can render while the user types without forcing
   * a save. It returns the email exactly as send-email.ts will compose it:
   * body -> per-inbox signature -> footer (default sig block / custom / none).
   *
   * Sample selection degrades rather than returning nothing:
   *   1. leads matching the filters that this campaign hasn't messaged yet
   *   2. any lead matching the filters (already-messaged included)
   *   3. any lead at all
   *   4. a synthetic placeholder lead
   * so the preview is never blank — which is what made it look like it only
   * worked after a campaign had already sent.
   */
  app.post("/api/campaigns/preview", { preHandler: requireAuth }, async (req, reply) => {
    const draft = previewBody.safeParse(req.body);
    if (!draft.success)
      return reply.code(400).send({ error: "bad_request", detail: draft.error.issues });
    const d = draft.data;

    const filtersJson = (d.filters ?? {}) as Prisma.JsonValue;
    const suppressed = await prisma.suppression.findMany({ select: { email: true } });
    const suppressedEmails = suppressed.map((s) => s.email);

    const eligibleWhere = eligibleLeadWhere(
      { id: d.id ?? undefined, regionId: d.regionId ?? null, filtersJson },
      suppressedEmails,
    );
    // Same filter, but without the "not yet messaged by this campaign" clause,
    // so a fully-sent campaign still previews.
    const anyMatchingWhere = eligibleLeadWhere(
      { regionId: d.regionId ?? null, filtersJson },
      suppressedEmails,
    );

    const [eligibleCount, eligibleSamples] = await Promise.all([
      prisma.lead.count({ where: eligibleWhere }),
      prisma.lead.findMany({ where: eligibleWhere, take: 3, orderBy: { createdAt: "desc" } }),
    ]);

    let samples = eligibleSamples;
    let sampleSource: "eligible" | "matching" | "any" | "placeholder" = "eligible";
    if (samples.length === 0) {
      samples = await prisma.lead.findMany({
        where: anyMatchingWhere,
        take: 3,
        orderBy: { createdAt: "desc" },
      });
      sampleSource = "matching";
    }
    if (samples.length === 0) {
      samples = await prisma.lead.findMany({ take: 3, orderBy: { createdAt: "desc" } });
      sampleSource = "any";
    }

    type SampleVars = ReturnType<typeof leadMergeVars> & { __to: string };
    let varsList: SampleVars[];
    if (samples.length === 0) {
      sampleSource = "placeholder";
      varsList = [
        {
          ...leadMergeVars({
            name: "Jordan Lee",
            company: "Acme Inc",
            city: "Springfield",
            state: "IL",
            title: "Head of Operations",
            email: "jordan@example.com",
          }),
          __to: "jordan@example.com",
        },
      ];
    } else {
      varsList = samples.map((l) => ({ ...leadMergeVars(l), __to: l.email }));
    }

    // The signature the worker will staple on is the connected inbox's own.
    // Show the first active connected inbox's signature so what you read here
    // is what the recipient gets.
    const accounts = await prisma.account.findMany({ where: { status: "active" } });
    const signature = accounts.find((a) => a.signature)?.signature ?? null;
    const sender = env.sender();
    const isHtml = !!d.isHtml;

    /** Same composer the send job uses, so the preview is what gets sent. */
    const compose = (renderedBody: string): string =>
      composeBody({
        body: renderedBody,
        isHtml,
        signature,
        footerOverride: d.footerOverride ?? null,
        sender,
      });

    /**
     * Spintax picks a branch at random. On a live preview that re-renders on
     * every keystroke that would flicker, so seed the rng per (step, sample)
     * — stable across keystrokes, still different between recipients so you
     * can see the variation the spintax actually produces.
     */
    const renderStep = (subjectTpl: string, bodyTpl: string, stepKey: string) =>
      varsList.map((v, i) => {
        const { __to, ...vars } = v;
        let seed = i * 2654435761;
        for (let k = 0; k < stepKey.length; k++) seed = (seed * 31 + stepKey.charCodeAt(k)) | 0;
        return {
          to: __to,
          subject: renderTemplate(subjectTpl, vars, seededRng(seed)),
          body: compose(renderTemplate(bodyTpl, vars, seededRng(seed + 7))),
        };
      });

    const steps: {
      key: string;
      label: string;
      variant: "A" | "B";
      dayOffset: number;
      samples: { to: string; subject: string; body: string }[];
    }[] = [];

    steps.push({
      key: "a",
      label: d.abEnabled ? "Initial email — variant A" : "Initial email",
      variant: "A",
      dayOffset: 0,
      samples: renderStep(d.subjectTemplate ?? "", d.bodyTemplate ?? "", "a"),
    });

    if (d.abEnabled) {
      steps.push({
        key: "b",
        label: "Initial email — variant B",
        variant: "B",
        dayOffset: 0,
        samples: renderStep(d.subjectVariantB ?? "", d.bodyVariantB ?? "", "b"),
      });
    }

    (d.followUps ?? []).forEach((f, i) => {
      steps.push({
        key: `f${i}`,
        label: `Follow-up ${i + 1} — day +${f.dayOffset}, if no reply`,
        variant: "A",
        dayOffset: f.dayOffset,
        samples: renderStep(f.subjectTemplate, f.bodyTemplate, `f${i}`),
      });
    });

    const budget = dailyBudgetFrom(accounts);
    return {
      eligibleCount,
      dailyBudget: budget,
      etaBusinessDays: estimateCompletionDays(eligibleCount, budget),
      sampleSource,
      isHtml,
      signatureApplied: !!signature,
      footerMode: d.footerOverride == null ? "default" : d.footerOverride.trim() ? "custom" : "none",
      steps,
    };
  });

  // Preview: render the template against up to `n` real eligible leads.
  app.get("/api/campaigns/:id/preview", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return reply.code(404).send({ error: "not_found" });

    // Exclude suppressed emails so the count/ETA reflect what will actually send.
    const suppressed = await prisma.suppression.findMany({ select: { email: true } });
    const where = eligibleLeadWhere(campaign, suppressed.map((s) => s.email));
    const [count, samples] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({ where, take: 5 }),
    ]);

    const rendered = samples.map((l) => ({
      to: l.email,
      subject: renderTemplate(campaign.subjectTemplate, leadMergeVars(l)),
      body: renderTemplate(campaign.bodyTemplate, leadMergeVars(l)),
    }));

    // ETA at current healthy-account budget.
    const accounts = await prisma.account.findMany({ where: { status: "active" } });
    const budget = dailyBudgetFrom(accounts);

    return {
      eligibleCount: count,
      dailyBudget: budget,
      etaBusinessDays: estimateCompletionDays(count, budget),
      samples: rendered,
    };
  });

  // Launch: enforce placement-test gate, mark running. The daily-planner
  // (worker) picks up eligible leads each night per the timing algorithm.
  app.post("/api/campaigns/:id/launch", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ placementTestConfirmed: z.boolean() })
      .safeParse(req.body);
    if (!body.success || !body.data.placementTestConfirmed) {
      return reply
        .code(400)
        .send({ error: "placement_test_required", message: "Confirm the placement test before launch." });
    }
    const campaign = await prisma.campaign.update({
      where: { id },
      data: { status: "running", placementTestConfirmed: true, scheduledStartAt: null },
    });
    await prisma.event.create({
      data: { type: "campaign_launched", payload: { campaignId: id } },
    });
    // Plan immediately instead of waiting for the nightly 00:05 UTC run, so
    // the Queue fills right after launch (still respects caps/windows).
    await plannerQueue.add("plan-on-launch", {}, { removeOnComplete: true });
    await audit("campaign.launch", id);
    return { ok: true, campaign };
  });

  app.post("/api/campaigns/:id/pause", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.campaign.update({ where: { id }, data: { status: "paused" } });
    // Stop today's already-queued sends, not just future planning.
    const canceled = await cancelCampaignQueued(id);
    await audit("campaign.pause", id, { canceled });
    return { ok: true, canceled };
  });

  // Resume a paused campaign (back to running; planner picks it up next run).
  app.post("/api/campaigns/:id/resume", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) return reply.code(404).send({ error: "not_found" });
    if (!c.placementTestConfirmed)
      return reply.code(400).send({ error: "placement_test_required" });
    await prisma.campaign.update({ where: { id }, data: { status: "running" } });
    // Re-plan immediately so paused (now `planned`) sends go back in the queue.
    await plannerQueue.add("plan-on-resume", {}, { removeOnComplete: true });
    await audit("campaign.resume", id);
    return { ok: true };
  });

  // Schedule a draft/paused campaign to auto-start at a future time.
  app.post("/api/campaigns/:id/schedule", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ startAt: z.string().datetime(), placementTestConfirmed: z.boolean() })
      .safeParse(req.body);
    if (!body.success || !body.data.placementTestConfirmed)
      return reply.code(400).send({ error: "placement_test_required" });
    await prisma.campaign.update({
      where: { id },
      data: {
        status: "scheduled",
        scheduledStartAt: new Date(body.data.startAt),
        placementTestConfirmed: true,
      },
    });
    await audit("campaign.schedule", id, { startAt: body.data.startAt });
    return { ok: true };
  });

  // Archive / unarchive (hidden from default list, retained for history).
  app.post("/api/campaigns/:id/archive", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.campaign.update({
      where: { id },
      data: { archivedAt: new Date(), status: "paused" },
    });
    await cancelCampaignQueued(id);
    await audit("campaign.archive", id);
    return { ok: true };
  });

  app.post("/api/campaigns/:id/unarchive", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.campaign.update({ where: { id }, data: { archivedAt: null } });
    return { ok: true };
  });

  // Duplicate a campaign's config into a fresh draft (no messages/history).
  app.post("/api/campaigns/:id/duplicate", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) return reply.code(404).send({ error: "not_found" });
    const copy = await prisma.campaign.create({
      data: {
        name: `${c.name} (copy)`,
        status: "draft",
        regionId: c.regionId,
        subjectTemplate: c.subjectTemplate,
        bodyTemplate: c.bodyTemplate,
        subjectVariantB: c.subjectVariantB,
        bodyVariantB: c.bodyVariantB,
        abEnabled: c.abEnabled,
        followUpsJson: c.followUpsJson as Prisma.InputJsonValue,
        filtersJson: c.filtersJson as Prisma.InputJsonValue,
        isHtml: c.isHtml,
        trackOpens: c.trackOpens,
        trackClicks: c.trackClicks,
        unsubHeader: c.unsubHeader,
        footerOverride: c.footerOverride,
      },
    });
    await audit("campaign.duplicate", copy.id, { from: id });
    return { ok: true, campaign: copy };
  });

  // Delete a draft/archived campaign (guard against nuking live history).
  app.delete("/api/campaigns/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c) return { ok: true };
    if (c.status === "running")
      return reply.code(409).send({ error: "campaign_running", message: "Pause before deleting." });
    // Detach messages (keep send history) rather than cascade-deleting them.
    await prisma.message.updateMany({ where: { campaignId: id }, data: { campaignId: null } });
    await prisma.campaign.delete({ where: { id } }).catch(() => {});
    await audit("campaign.delete", id);
    return { ok: true };
  });

  // A/B report: per-variant sent / reply counts and reply rate.
  app.get("/api/campaigns/:id/ab", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const variants = ["A", "B"] as const;
    const rows = await Promise.all(
      variants.map(async (v) => {
        const sent = await prisma.message.count({
          where: { campaignId: id, direction: "out", status: "sent", variant: v, stepIndex: 0 },
        });
        // A reply is attributed to the variant of the lead's initial send.
        const repliedLeads = await prisma.message.findMany({
          where: { campaignId: id, direction: "out", variant: v, stepIndex: 0 },
          select: { leadId: true },
        });
        const leadIds = repliedLeads.map((r) => r.leadId);
        const replies = leadIds.length
          ? await prisma.message.count({
              where: { campaignId: id, direction: "in", leadId: { in: leadIds } },
            })
          : 0;
        const opens = await prisma.message.count({
          where: { campaignId: id, variant: v, stepIndex: 0, openedAt: { not: null } },
        });
        return { variant: v, sent, replies, opens, replyRate: sent ? replies / sent : 0 };
      }),
    );
    return { variants: rows };
  });

  // Run a built-in inbox placement test: the real rendered campaign email is
  // sent from every active connected inbox to every other one; a delayed job
  // then reads which folder Gmail filed each copy in. Advisory only (warn).
  app.post(
    "/api/campaigns/:id/placement-test",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const campaign = await prisma.campaign.findUnique({ where: { id } });
      if (!campaign) return reply.code(404).send({ error: "not_found" });

      const connected = await prisma.account.count({
        where: { status: "active", oauthRefreshEnc: { not: null } },
      });
      if (connected < 2)
        return reply.code(400).send({
          error: "need_seeds",
          message: "Placement test needs at least 2 connected active inboxes.",
        });

      // One in-flight test per campaign at a time.
      const inflight = await prisma.placementTest.findFirst({
        where: { campaignId: id, status: { in: ["pending", "sent"] } },
      });
      if (inflight)
        return reply.code(409).send({ error: "test_in_progress", test: inflight });

      const test = await prisma.placementTest.create({
        data: { campaignId: id, tag: crypto.randomBytes(8).toString("hex") },
      });
      await placementQueue.add(
        "send",
        { placementTestId: test.id, phase: "send" },
        { removeOnComplete: true },
      );
      await audit("campaign.placement_test", id, { testId: test.id });
      return { ok: true, test };
    },
  );

  // Latest placement test (with summary counts) for the campaign panel.
  app.get(
    "/api/campaigns/:id/placement-test",
    { preHandler: requireAuth },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const test = await prisma.placementTest.findFirst({
        where: { campaignId: id },
        orderBy: { createdAt: "desc" },
      });
      if (!test) return { test: null };
      const pairs = (test.resultsJson as { folder: string }[]) ?? [];
      const count = (f: string) => pairs.filter((p) => p.folder === f).length;
      return {
        test,
        summary: {
          total: pairs.length,
          inbox: count("inbox"),
          spam: count("spam"),
          promotions: count("promotions"),
          missing: count("missing") + count("send_failed"),
          pending: count("pending"),
        },
      };
    },
  );
}
