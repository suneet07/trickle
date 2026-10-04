import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { prisma, LeadStatus, Prisma } from "@trickle/db";
import { resolveTimezone, renderTemplate, isValidTimezone, leadMergeVars } from "@trickle/core";
import { env, sendQueue } from "@trickle/shared";
import { requireAuth } from "../auth.js";
import { audit, toCsv } from "../audit.js";

const LEAD_STATUSES = [
  "pending",
  "contacted",
  "followup",
  "replied",
  "bounced",
  "unsubscribed",
  "do_not_contact",
] as const;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Header aliases for each built-in field, compared lowercased and trimmed.
// Every other column is kept as a custom field.
const COLUMN_ALIASES = {
  firstName: ["first name", "firstname", "first", "given name"],
  lastName: ["last name", "lastname", "last", "surname", "family name"],
  name: ["name", "full name", "fullname", "contact", "contact name"],
  email: ["email", "email address", "e-mail", "mail"],
  company: ["company", "company name", "organization", "organisation", "business", "account"],
  title: ["title", "job title", "role", "position"],
  city: ["city", "town"],
  state: ["state", "st", "province", "state/province"],
  zip: ["zip", "zipcode", "zip code", "postal", "postal code", "postcode"],
  timezone: ["timezone", "time zone", "tz"],
} as const;
const KNOWN_COLUMNS = new Set<string>(Object.values(COLUMN_ALIASES).flat());

/** Max custom fields kept per lead, so a 300-column export can't bloat rows. */
const MAX_CUSTOM_FIELDS = 30;

/** Normalize an arbitrary header row into our canonical field names. */
function mapRow(row: Record<string, unknown>): {
  name?: string;
  email?: string;
  company?: string;
  title?: string;
  city?: string;
  state?: string;
  zip?: string;
  timezone?: string;
  customFields: Record<string, string>;
} {
  const lower: Record<string, string> = {};
  const customFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim();
    const value = v == null ? "" : String(v).trim();
    lower[key.toLowerCase()] = value;
    if (
      key &&
      value &&
      !KNOWN_COLUMNS.has(key.toLowerCase()) &&
      Object.keys(customFields).length < MAX_CUSTOM_FIELDS
    ) {
      customFields[key] = value.slice(0, 1000);
    }
  }
  const pick = (keys: readonly string[]) => {
    for (const k of keys) if (lower[k]) return lower[k];
    return undefined;
  };
  const firstName = pick(COLUMN_ALIASES.firstName);
  const lastName = pick(COLUMN_ALIASES.lastName);
  const combinedName = [firstName, lastName].filter(Boolean).join(" ") || undefined;
  return {
    name: pick(COLUMN_ALIASES.name) ?? combinedName,
    email: pick(COLUMN_ALIASES.email),
    company: pick(COLUMN_ALIASES.company),
    title: pick(COLUMN_ALIASES.title),
    city: pick(COLUMN_ALIASES.city),
    state: pick(COLUMN_ALIASES.state),
    zip: pick(COLUMN_ALIASES.zip),
    timezone: pick(COLUMN_ALIASES.timezone),
    customFields,
  };
}

export default async function leadRoutes(app: FastifyInstance) {
  // List / search / filter.
  app.get("/api/leads", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        regionId: z.string().optional(),
        timezone: z.string().optional(),
        search: z.string().optional(),
        take: z.coerce.number().int().min(1).max(500).default(100),
        skip: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where: Prisma.LeadWhereInput = {};
    if (q.status) where.status = q.status as LeadStatus;
    if (q.regionId) where.regionId = q.regionId;
    if (q.timezone) where.timezone = q.timezone;
    if (q.search)
      where.OR = [
        { email: { contains: q.search, mode: "insensitive" } },
        { name: { contains: q.search, mode: "insensitive" } },
        { company: { contains: q.search, mode: "insensitive" } },
      ];

    const [total, leads] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.take,
        skip: q.skip,
        include: { region: { select: { name: true } }, account: { select: { email: true } } },
      }),
    ]);
    return { total, leads };
  });

  // Ids of every lead matching the current filters, so the UI can bulk-edit a
  // whole filtered set instead of only the rows it has paged in. Ids only —
  // deliberately not the rows.
  app.get("/api/leads/ids", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        regionId: z.string().optional(),
        timezone: z.string().optional(),
        search: z.string().optional(),
      })
      .parse(req.query);
    const where: Prisma.LeadWhereInput = {};
    if (q.status) where.status = q.status as LeadStatus;
    if (q.regionId) where.regionId = q.regionId;
    if (q.timezone) where.timezone = q.timezone;
    if (q.search)
      where.OR = [
        { email: { contains: q.search, mode: "insensitive" } },
        { name: { contains: q.search, mode: "insensitive" } },
        { company: { contains: q.search, mode: "insensitive" } },
      ];
    const rows = await prisma.lead.findMany({ where, select: { id: true }, take: 50000 });
    return { ids: rows.map((r) => r.id) };
  });

  // Distinct timezones with lead counts, for the campaign timezone filter and
  // the leads-list timezone filter. Cheap groupBy; no joins.
  app.get("/api/leads/timezones", { preHandler: requireAuth }, async () => {
    const groups = await prisma.lead.groupBy({
      by: ["timezone"],
      _count: { _all: true },
    });
    return groups
      .map((g) => ({ timezone: g.timezone, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  });

  // Distinct cities with lead counts (merged case-insensitively) for the
  // campaign city filter.
  app.get("/api/leads/cities", { preHandler: requireAuth }, async () => {
    const groups = await prisma.lead.groupBy({
      by: ["city"],
      _count: { _all: true },
      where: { city: { not: null } },
    });
    // Merge case/whitespace variants: key by trimmed-lowercase, keep a display form.
    const merged = new Map<string, { city: string; count: number }>();
    for (const g of groups) {
      const raw = (g.city ?? "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const existing = merged.get(key);
      const count = g._count._all;
      if (existing) existing.count += count;
      else merged.set(key, { city: titleCase(raw), count });
    }
    return [...merged.values()].sort((a, b) => b.count - a.count);
  });

  // CSV / XLSX import with dedupe + validation + tz/region assignment.
  app.post("/api/leads/import", { preHandler: requireAuth }, async (req, reply) => {
    const file = await (req as any).file?.();
    if (!file) return reply.code(400).send({ error: "no_file" });

    const buf = await file.toBuffer();
    const filename: string = file.filename ?? "";
    const regionId = (file.fields?.regionId?.value as string | undefined) ?? undefined;
    // Explicit per-import timezone override. Precedence, highest first:
    //   1. this field  2. the chosen region's timezone  3. the state/zip map.
    // Omitted = unchanged legacy behaviour.
    const tzOverrideRaw = (file.fields?.timezone?.value as string | undefined) ?? undefined;
    const tzOverride = tzOverrideRaw?.trim() || undefined;
    if (tzOverride && !isValidTimezone(tzOverride))
      return reply.code(400).send({ error: "invalid_timezone", message: `Unknown timezone: ${tzOverride}` });

    let rows: Record<string, unknown>[] = [];
    if (filename.toLowerCase().endsWith(".csv")) {
      rows = csvParse(buf, { columns: true, skip_empty_lines: true, trim: true });
    } else {
      const wb = XLSX.read(buf, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]!]!;
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    }

    let skippedInvalid = 0;
    let skippedDupe = 0;
    const region = regionId
      ? await prisma.region.findUnique({ where: { id: regionId } })
      : null;

    // Region auto-assignment: when no region is chosen at import, match a lead's
    // state to a region's `states[]` so region-filtered campaigns don't silently
    // miss them. Loaded once, not per-row.
    // An explicit timezone means the user is overriding auto-assignment on
    // purpose, so don't let state-matching quietly attach a region behind it.
    const allRegions = region || tzOverride ? [] : await prisma.region.findMany();
    const regionByState = new Map<string, { id: string; timezone: string }>();
    for (const r of allRegions)
      for (const st of r.states)
        if (!regionByState.has(st.toUpperCase()))
          regionByState.set(st.toUpperCase(), { id: r.id, timezone: r.timezone });

    // (1) Parse + validate + dedupe within the file (first-wins).
    const candidates = new Map<
      string,
      {
        name?: string; email: string; company?: string; title?: string;
        city?: string; state?: string; zip?: string;
        timezone: string; regionId?: string; customFields: Record<string, string>;
      }
    >();
    for (const raw of rows) {
      const m = mapRow(raw);
      const email = m.email?.toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        skippedInvalid++;
        continue;
      }
      if (candidates.has(email)) {
        skippedDupe++;
        continue;
      }
      const stateKey = m.state?.trim().toUpperCase();
      const matched = region
        ? { id: region.id, timezone: region.timezone }
        : stateKey
          ? regionByState.get(stateKey)
          : undefined;
      // Timezone precedence: import override > chosen region > the row's own
      // timezone column > region matched by state > US state/zip map > default.
      const rowTz = m.timezone && isValidTimezone(m.timezone) ? m.timezone : undefined;
      candidates.set(email, {
        ...m,
        email,
        timezone:
          tzOverride ??
          (region ? region.timezone : undefined) ??
          rowTz ??
          matched?.timezone ??
          resolveTimezone(m.state, m.zip, env.defaultTimezone()),
        regionId: matched?.id,
      });
    }

    // (2) Batch-check dedupe against existing leads + suppressions (2 queries).
    const emails = [...candidates.keys()];
    const [existing, suppressed] = await Promise.all([
      prisma.lead.findMany({ where: { email: { in: emails } }, select: { email: true } }),
      prisma.suppression.findMany({ where: { email: { in: emails } }, select: { email: true } }),
    ]);
    const taken = new Set([
      ...existing.map((e) => e.email),
      ...suppressed.map((s) => s.email),
    ]);

    const toCreate = [...candidates.values()].filter((c) => {
      if (taken.has(c.email)) {
        skippedDupe++;
        return false;
      }
      return true;
    });

    // (3) Single bulk insert (skipDuplicates guards a race on the unique email).
    const res = await prisma.lead.createMany({
      data: toCreate.map((c) => ({
        name: c.name,
        email: c.email,
        company: c.company,
        title: c.title,
        city: c.city,
        state: c.state,
        zip: c.zip,
        timezone: c.timezone,
        source: filename,
        regionId: c.regionId,
        customFields: c.customFields,
      })),
      skipDuplicates: true,
    });

    // Echo what was actually applied so the UI can state it instead of the
    // user having to open a lead to find out.
    const appliedRegion = region?.name ?? null;
    const appliedTimezone = tzOverride ?? region?.timezone ?? null;
    const unmatchedRegion = toCreate.filter((c) => !c.regionId).length;
    return {
      imported: res.count,
      skippedInvalid,
      skippedDupe,
      total: rows.length,
      appliedRegion,
      appliedTimezone,
      unmatchedRegion,
    };
  });

  // Manually add a single lead by hand.
  app.post("/api/leads", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().optional(),
        email: z.string(),
        company: z.string().optional(),
        title: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        regionId: z.string().optional(),
        timezone: z.string().optional(),
        customFields: z.record(z.string().max(1000)).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const manualTz = body.data.timezone?.trim() || undefined;
    if (manualTz && !isValidTimezone(manualTz))
      return reply.code(400).send({ error: "invalid_timezone", message: `Unknown timezone: ${manualTz}` });

    const email = body.data.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email))
      return reply.code(400).send({ error: "invalid_email", message: "Invalid email address." });

    const [existing, suppressed] = await Promise.all([
      prisma.lead.findUnique({ where: { email } }),
      prisma.suppression.findUnique({ where: { email } }),
    ]);
    if (existing)
      return reply.code(409).send({ error: "duplicate", message: "That email is already a lead." });
    if (suppressed)
      return reply.code(409).send({ error: "suppressed", message: "That email is on the suppression list." });

    const region = body.data.regionId
      ? await prisma.region.findUnique({ where: { id: body.data.regionId } })
      : null;
    const timezone =
      manualTz ??
      region?.timezone ??
      resolveTimezone(body.data.state, body.data.zip, env.defaultTimezone());

    const lead = await prisma.lead.create({
      data: {
        name: body.data.name,
        email,
        company: body.data.company,
        title: body.data.title,
        city: body.data.city,
        state: body.data.state,
        zip: body.data.zip,
        timezone,
        source: "manual",
        regionId: region?.id,
        customFields: body.data.customFields ?? {},
      },
    });
    return { ok: true, lead };
  });

  // Send a one-off email to a single lead, right now. Reuses the send pipeline
  // (suppression check, footer, dry-run/live toggle). campaignId=null.
  app.post("/api/leads/:id/send", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        accountId: z.string(),
        subject: z.string().min(1),
        body: z.string().min(1),
        isHtml: z.boolean().optional(),
        trackOpens: z.boolean().optional(),
        trackClicks: z.boolean().optional(),
        unsubHeader: z.boolean().optional(),
        // Omitted/null = default sig-block footer; "" = no footer; text = custom.
        footerOverride: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) return reply.code(404).send({ error: "not_found" });

    const suppressed = await prisma.suppression.findUnique({ where: { email: lead.email } });
    if (suppressed)
      return reply.code(409).send({ error: "suppressed", message: "This lead is suppressed." });

    const account = await prisma.account.findFirst({
      where: { id: body.data.accountId, oauthRefreshEnc: { not: null } },
    });
    if (!account)
      return reply.code(400).send({ error: "no_account", message: "Pick a connected inbox." });

    // Allow merge vars in the one-off too.
    const vars = leadMergeVars(lead);

    const msg = await prisma.message.create({
      data: {
        direction: "out",
        status: "planned",
        stepIndex: 0,
        subject: renderTemplate(body.data.subject, vars),
        body: renderTemplate(body.data.body, vars),
        scheduledAt: new Date(),
        leadId: lead.id,
        accountId: account.id,
        isHtml: body.data.isHtml ?? false,
        trackOpens: body.data.trackOpens ?? false,
        trackClicks: body.data.trackClicks ?? false,
        unsubHeader: body.data.unsubHeader ?? false,
        footerOverride: body.data.footerOverride ?? null,
      },
    });
    const job = await sendQueue.add(
      "send-email",
      { messageId: msg.id },
      { delay: 0, removeOnComplete: true },
    );
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "queued", bulljobId: job.id },
    });
    return { ok: true, messageId: msg.id };
  });

  // Delete a single lead (cascades its messages).
  app.delete("/api/leads/:id", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.lead.delete({ where: { id } }).catch(() => {});
    return { ok: true };
  });

  // Bulk delete.
  app.post("/api/leads/bulk-delete", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const res = await prisma.lead.deleteMany({ where: { id: { in: body.data.ids } } });
    return { ok: true, deleted: res.count };
  });

  // Clear ALL leads (messages cascade). Destructive — the UI double-confirms.
  app.post("/api/leads/clear-all", { preHandler: requireAuth }, async () => {
    const res = await prisma.lead.deleteMany({});
    await audit("lead.clear_all", undefined, { deleted: res.count });
    return { ok: true, deleted: res.count };
  });

  app.patch("/api/leads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(LEAD_STATUSES).optional(),
        notes: z.string().optional(),
        accountId: z.string().nullable().optional(),
        regionId: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        company: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
        timezone: z.string().optional(),
        customFields: z.record(z.string().max(1000)).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.timezone !== undefined && !isValidTimezone(body.data.timezone))
      return reply
        .code(400)
        .send({ error: "invalid_timezone", message: `Unknown timezone: ${body.data.timezone}` });
    await prisma.lead.update({ where: { id }, data: body.data });
    await audit("lead.update", id, body.data as Record<string, unknown>);
    return { ok: true };
  });

  // Lead detail: the lead plus its full message sequence (which step is next).
  app.get("/api/leads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        region: { select: { id: true, name: true } },
        account: { select: { id: true, email: true } },
        messages: {
          orderBy: [{ stepIndex: "asc" }, { createdAt: "asc" }],
          include: { campaign: { select: { status: true } } },
        },
      },
    });
    if (!lead) return reply.code(404).send({ error: "not_found" });
    const suppressed = await prisma.suppression.findUnique({ where: { email: lead.email } });
    // "Next" = an upcoming send whose campaign is actually live (or a one-off).
    const nextStep = lead.messages.find(
      (m) =>
        m.direction === "out" &&
        (m.status === "planned" || m.status === "queued") &&
        (!m.campaign || m.campaign.status === "running"),
    );
    return { lead, suppressed: !!suppressed, nextStep: nextStep ?? null };
  });

  // Snooze (pause all sends until a date) or un-snooze (null).
  app.post("/api/leads/:id/snooze", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ until: z.string().datetime().nullable() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const snoozeUntil = body.data.until ? new Date(body.data.until) : null;
    await prisma.lead.update({ where: { id }, data: { snoozeUntil } });
    await audit("lead.snooze", id, { until: body.data.until });
    return { ok: true };
  });

  // Skip the lead's next pending follow-up (cancel just that step).
  app.post("/api/leads/:id/skip-followup", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const next = await prisma.message.findFirst({
      where: {
        leadId: id,
        direction: "out",
        stepIndex: { gt: 0 },
        status: { in: ["planned", "queued"] },
      },
      orderBy: { stepIndex: "asc" },
    });
    if (!next) return { ok: true, skipped: 0 };
    await prisma.message.update({ where: { id: next.id }, data: { status: "canceled" } });
    await audit("lead.skip_followup", id, { messageId: next.id });
    return { ok: true, skipped: 1 };
  });

  // Bulk status change.
  app.post("/api/leads/bulk-status", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ ids: z.array(z.string()).min(1), status: z.enum(LEAD_STATUSES) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const res = await prisma.lead.updateMany({
      where: { id: { in: body.data.ids } },
      data: { status: body.data.status },
    });
    await audit("lead.bulk_status", undefined, { count: res.count, status: body.data.status });
    return { ok: true, updated: res.count };
  });

  // Bulk region reassignment (null to clear).
  app.post("/api/leads/bulk-region", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ ids: z.array(z.string()).min(1), regionId: z.string().nullable() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Keep timezone consistent with the new region when one is set.
    const region = body.data.regionId
      ? await prisma.region.findUnique({ where: { id: body.data.regionId } })
      : null;
    const data: Prisma.LeadUncheckedUpdateManyInput = { regionId: body.data.regionId };
    if (region) data.timezone = region.timezone;
    const res = await prisma.lead.updateMany({ where: { id: { in: body.data.ids } }, data });
    await audit("lead.bulk_region", undefined, { count: res.count, regionId: body.data.regionId });
    return { ok: true, updated: res.count };
  });

  // Bulk timezone reassignment. Sets the timezone directly and leaves region
  // alone — the two are deliberately independent so a manual timezone fix
  // can't be undone by a later region edit.
  app.post("/api/leads/bulk-timezone", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ ids: z.array(z.string()).min(1), timezone: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const tz = body.data.timezone.trim();
    if (!isValidTimezone(tz))
      return reply.code(400).send({ error: "invalid_timezone", message: `Unknown timezone: ${tz}` });
    const res = await prisma.lead.updateMany({
      where: { id: { in: body.data.ids } },
      data: { timezone: tz },
    });
    await audit("lead.bulk_timezone", undefined, { count: res.count, timezone: tz });
    return { ok: true, updated: res.count };
  });

  // Bulk sending-account reassignment (null to clear/round-robin later).
  app.post("/api/leads/bulk-account", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ ids: z.array(z.string()).min(1), accountId: z.string().nullable() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const res = await prisma.lead.updateMany({
      where: { id: { in: body.data.ids } },
      data: { accountId: body.data.accountId },
    });
    await audit("lead.bulk_account", undefined, { count: res.count, accountId: body.data.accountId });
    return { ok: true, updated: res.count };
  });

  // CSV export of leads (respects the same filters as the list view).
  app.get("/api/leads/export", { preHandler: requireAuth }, async (req, reply) => {
    const q = z
      .object({
        status: z.string().optional(),
        regionId: z.string().optional(),
        search: z.string().optional(),
      })
      .parse(req.query);
    const where: Prisma.LeadWhereInput = {};
    if (q.status) where.status = q.status as LeadStatus;
    if (q.regionId) where.regionId = q.regionId;
    if (q.search)
      where.OR = [
        { email: { contains: q.search, mode: "insensitive" } },
        { name: { contains: q.search, mode: "insensitive" } },
        { company: { contains: q.search, mode: "insensitive" } },
      ];
    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { region: { select: { name: true } } },
      take: 50000,
    });
    // Custom fields become extra columns, so an export re-imports losslessly.
    const customKeys = [
      ...new Set(
        leads.flatMap((l) =>
          l.customFields && typeof l.customFields === "object" && !Array.isArray(l.customFields)
            ? Object.keys(l.customFields as Record<string, unknown>)
            : [],
        ),
      ),
    ];
    const base = ["name", "email", "company", "title", "city", "state", "zip", "status", "region", "timezone", "createdAt"];
    const csv = toCsv(
      leads.map((l) => ({
        ...((l.customFields ?? {}) as Record<string, unknown>),
        name: l.name,
        email: l.email,
        company: l.company,
        title: l.title,
        city: l.city,
        state: l.state,
        zip: l.zip,
        status: l.status,
        region: l.region?.name,
        timezone: l.timezone,
        createdAt: l.createdAt.toISOString(),
      })),
      [...base, ...customKeys.filter((k) => !base.includes(k))],
    );
    return reply
      .type("text/csv")
      .header("content-disposition", `attachment; filename="leads-${Date.now()}.csv"`)
      .send(csv);
  });
}
