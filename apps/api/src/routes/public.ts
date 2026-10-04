import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trickle/db";
import { verifyUnsubscribeToken, verifyTrackingToken, PIXEL_GIF } from "@trickle/shared";

export default async function publicRoutes(app: FastifyInstance) {
  // One-click unsubscribe (GET for humans, POST for RFC 8058 one-click).
  const handle = async (req: any, reply: any) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const email = verifyUnsubscribeToken(token);
    if (!email) return reply.code(400).type("text/html").send("Invalid link.");

    await prisma.$transaction([
      prisma.suppression.upsert({
        where: { email },
        update: {},
        create: { email, reason: "unsub" },
      }),
      prisma.lead.updateMany({ where: { email }, data: { status: "unsubscribed" } }),
    ]);
    await prisma.message.updateMany({
      where: {
        lead: { email },
        direction: "out",
        status: { in: ["planned", "queued"] },
      },
      data: { status: "canceled" },
    });

    return reply
      .type("text/html")
      .send(
        `<html><body style="font-family:sans-serif;padding:2rem">You've been unsubscribed. You won't receive further emails.</body></html>`,
      );
  };

  app.get("/u/:token", handle);
  app.post("/u/:token", handle);

  // Open pixel: records the first open, then returns a 1x1 GIF. Token carries a
  // ".gif" suffix in the URL for realism; strip it before verifying.
  app.get("/o/:token", async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const payload = verifyTrackingToken(token.replace(/\.gif$/, ""));
    if (payload?.m) {
      await prisma.message
        .updateMany({ where: { id: payload.m, openedAt: null }, data: { openedAt: new Date() } })
        .catch(() => {});
    }
    return reply
      .type("image/gif")
      .header("cache-control", "no-store, no-cache, must-revalidate, private")
      .send(PIXEL_GIF);
  });

  // Click redirect: records the click, then 302s to the (signed) target URL.
  app.get("/c/:token", async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const payload = verifyTrackingToken(token);
    if (!payload?.u || !/^https?:\/\//i.test(payload.u)) {
      return reply.code(400).type("text/html").send("Invalid link.");
    }
    if (payload.m) {
      await prisma.message
        .updateMany({ where: { id: payload.m, clickedAt: null }, data: { clickedAt: new Date() } })
        .catch(() => {});
    }
    return reply.redirect(payload.u);
  });
}
