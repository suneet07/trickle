import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, LeadStatus } from "@trickle/db";
import { sendQueue } from "@trickle/shared";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";

export default async function threadRoutes(app: FastifyInstance) {
  // Inbox view: any lead that has at least one message, filterable by status,
  // paginated. Default shows active conversations (replied/contacted/followup).
  app.get("/api/threads", { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        search: z.string().optional(),
        take: z.coerce.number().int().min(1).max(200).default(50),
        skip: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const where: any = { messages: { some: {} } };
    if (q.status) where.status = q.status as LeadStatus;
    else where.status = { in: ["replied", "contacted", "followup"] };
    if (q.search)
      where.OR = [
        { email: { contains: q.search, mode: "insensitive" } },
        { name: { contains: q.search, mode: "insensitive" } },
      ];

    const [total, leads] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: q.take,
        skip: q.skip,
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          account: { select: { id: true, email: true } },
        },
      }),
    ]);
    return { total, leads };
  });

  app.get("/api/threads/:leadId", { preHandler: requireAuth }, async (req) => {
    const { leadId } = z.object({ leadId: z.string() }).parse(req.params);
    return prisma.message.findMany({
      where: { leadId },
      orderBy: { createdAt: "asc" },
    });
  });

  // Reply from the app: send a message in the lead's existing thread. Reuses the
  // send pipeline (suppression check, threading, footer, dry-run).
  app.post("/api/threads/:leadId/reply", { preHandler: requireAuth }, async (req, reply) => {
    const { leadId } = z.object({ leadId: z.string() }).parse(req.params);
    const body = z
      .object({ subject: z.string().min(1), body: z.string().min(1), accountId: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return reply.code(404).send({ error: "not_found" });

    // Find the thread + a connected sending account (prefer the lead's own).
    const lastOut = await prisma.message.findFirst({
      where: { leadId, direction: "out", gmailThreadId: { not: null } },
      orderBy: { sentAt: "desc" },
    });
    const accountId = body.data.accountId ?? lastOut?.accountId ?? lead.accountId ?? undefined;
    if (!accountId) return reply.code(400).send({ error: "no_account", message: "No sending inbox for this lead." });
    const account = await prisma.account.findFirst({
      where: { id: accountId, oauthRefreshEnc: { not: null } },
    });
    if (!account) return reply.code(400).send({ error: "no_account", message: "Inbox not connected." });

    const msg = await prisma.message.create({
      data: {
        direction: "out",
        status: "planned",
        stepIndex: 0,
        isManualReply: true,
        subject: body.data.subject,
        body: body.data.body,
        scheduledAt: new Date(),
        leadId: lead.id,
        accountId,
        gmailThreadId: lastOut?.gmailThreadId ?? null,
      },
    });
    const job = await sendQueue.add("send-email", { messageId: msg.id }, { delay: 0 });
    await prisma.message.update({ where: { id: msg.id }, data: { status: "queued", bulljobId: job.id } });
    await audit("thread.reply", leadId, { messageId: msg.id });
    return { ok: true, messageId: msg.id };
  });
}
