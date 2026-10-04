import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trickle/db";
import { requireAuth } from "../auth.js";
import { audit, toCsv } from "../audit.js";

function bareDomain(input: string): string {
  const s = input.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  return at >= 0 ? s.slice(at + 1) : s;
}

export default async function suppressionRoutes(app: FastifyInstance) {
  app.get("/api/suppressions", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        search: z.string().optional(),
        take: z.coerce.number().int().min(1).max(500).default(200),
        skip: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const where = q.search
      ? { email: { contains: q.search, mode: "insensitive" as const } }
      : {};
    const [total, items] = await Promise.all([
      prisma.suppression.count({ where }),
      prisma.suppression.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.take,
        skip: q.skip,
      }),
    ]);
    return { total, items };
  });

  // Manually suppress an address (never email it again).
  app.post("/api/suppressions", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const email = body.data.email.trim().toLowerCase();
    await prisma.suppression.upsert({
      where: { email },
      update: {},
      create: { email, reason: "manual" },
    });
    await prisma.lead.updateMany({ where: { email }, data: { status: "do_not_contact" } });
    return { ok: true };
  });

  // Remove from suppression (re-allow). Also restore any lead that was flipped
  // to do_not_contact/unsubscribed solely by this suppression, so it's mailable
  // again.
  app.delete("/api/suppressions/:email", { preHandler: requireAuth }, async (req) => {
    const { email } = z.object({ email: z.string() }).parse(req.params);
    const lc = email.toLowerCase();
    await prisma.suppression.delete({ where: { email: lc } }).catch(() => {});
    await prisma.lead.updateMany({
      where: { email: lc, status: { in: ["do_not_contact", "unsubscribed"] } },
      data: { status: "pending" },
    });
    await audit("suppression.remove", lc);
    return { ok: true };
  });

  // CSV export of the suppression list.
  app.get("/api/suppressions/export", { preHandler: requireAuth }, async (_req, reply) => {
    const items = await prisma.suppression.findMany({ orderBy: { createdAt: "desc" }, take: 100000 });
    const csv = toCsv(
      items.map((s) => ({
        email: s.email,
        reason: s.reason,
        detail: s.detail,
        createdAt: s.createdAt.toISOString(),
      })),
      ["email", "reason", "detail", "createdAt"],
    );
    return reply
      .type("text/csv")
      .header("content-disposition", `attachment; filename="suppressions-${Date.now()}.csv"`)
      .send(csv);
  });

  // --- Domain blocklist ---------------------------------------------------
  app.get("/api/blocklist", { preHandler: requireAuth }, async (req) => {
    const q = z.object({ search: z.string().optional() }).parse(req.query);
    const where = q.search
      ? { domain: { contains: q.search.toLowerCase(), mode: "insensitive" as const } }
      : {};
    return prisma.blocklist.findMany({ where, orderBy: { createdAt: "desc" }, take: 1000 });
  });

  app.post("/api/blocklist", { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ domain: z.string().min(3), note: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const domain = bareDomain(body.data.domain);
    const entry = await prisma.blocklist.upsert({
      where: { domain },
      update: { note: body.data.note ?? null },
      create: { domain, note: body.data.note ?? null },
    });
    await audit("blocklist.add", domain);
    return { ok: true, entry };
  });

  app.delete("/api/blocklist/:domain", { preHandler: requireAuth }, async (req) => {
    const { domain } = z.object({ domain: z.string() }).parse(req.params);
    await prisma.blocklist.delete({ where: { domain: bareDomain(domain) } }).catch(() => {});
    await audit("blocklist.remove", bareDomain(domain));
    return { ok: true };
  });
}
