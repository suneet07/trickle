import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trickle/db";
import { requireAuth } from "../auth.js";

export default async function regionRoutes(app: FastifyInstance) {
  app.get("/api/regions", { preHandler: requireAuth }, async () => {
    return prisma.region.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { leads: true } } },
    });
  });

  const regionInput = z.object({
    name: z.string().min(1),
    states: z.array(z.string()).default([]),
    timezone: z.string().min(1),
  });

  app.post("/api/regions", { preHandler: requireAuth }, async (req, reply) => {
    const body = regionInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const region = await prisma.region.create({ data: body.data });
    return region;
  });

  app.put("/api/regions/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = regionInput.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const region = await prisma.region.update({ where: { id }, data: body.data });
    return region;
  });

  // Delete a region. Leads/campaigns keep working — their regionId is nullable
  // and set null on delete; block only if it would surprise the user silently.
  app.delete("/api/regions/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [leadCount, campaignCount] = await Promise.all([
      prisma.lead.count({ where: { regionId: id } }),
      prisma.campaign.count({ where: { regionId: id } }),
    ]);
    await prisma.lead.updateMany({ where: { regionId: id }, data: { regionId: null } });
    await prisma.campaign.updateMany({ where: { regionId: id }, data: { regionId: null } });
    await prisma.region.delete({ where: { id } }).catch(() => {});
    return { ok: true, detachedLeads: leadCount, detachedCampaigns: campaignCount };
  });
}
