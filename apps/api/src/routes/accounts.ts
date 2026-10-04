import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, Prisma, encrypt, decrypt } from "@trickle/db";
import { consentUrl, oauthClient, env, cancelSendJob } from "@trickle/shared";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";

// Short-lived state tokens for the OAuth handshake.
const pendingStates = new Map<string, number>();
function pruneStates() {
  const now = Date.now();
  for (const [k, exp] of pendingStates) if (exp <= now) pendingStates.delete(k);
}
function newState(): string {
  pruneStates(); // garbage-collect expired entries so the map can't grow forever
  const s = crypto.randomBytes(16).toString("hex");
  pendingStates.set(s, Date.now() + 10 * 60_000);
  return s;
}
function consumeState(s: string): boolean {
  const exp = pendingStates.get(s);
  pendingStates.delete(s);
  return !!exp && exp > Date.now();
}

/** Escape untrusted text before interpolating into an HTML response. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export default async function accountRoutes(app: FastifyInstance) {
  app.get("/api/accounts", { preHandler: requireAuth }, async () => {
    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        healthScore: true,
        dailyCapCold: true,
        warmupVolumeManual: true,
        warmedUp: true,
        warmupEnabled: true,
        warmupTarget: true,
        warmupSentTotal: true,
        signature: true,
        sendAsEmail: true,
        sendAsName: true,
        hourlyCap: true,
        minGapMinutes: true,
        sendWindowsJson: true,
        pausedUntil: true,
        oauthRefreshEnc: true,
        createdAt: true,
      },
    });
    return accounts.map((a) => ({
      ...a,
      connected: !!a.oauthRefreshEnc,
      oauthRefreshEnc: undefined,
    }));
  });

  // Begin OAuth: returns the Google consent URL to open.
  app.get("/api/accounts/oauth/start", { preHandler: requireAuth }, async (_req, reply) => {
    if (!env.googleConfigured())
      return reply.code(400).send({
        error: "google_not_configured",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Gmail inboxes.",
      });
    const state = newState();
    return { url: consentUrl(state) };
  });

  // OAuth callback (Google redirects the browser here — no auth preHandler,
  // state token protects it).
  app.get("/api/accounts/oauth/callback", async (req, reply) => {
    const q = z
      .object({ code: z.string(), state: z.string() })
      .safeParse(req.query);
    if (!q.success || !consumeState(q.data.state)) {
      return reply.code(400).send("Invalid OAuth state");
    }
    const client = oauthClient();
    // A stale/reused code or a Google-side hiccup must not 500 — fail politely.
    let tokens: Parameters<typeof client.setCredentials>[0];
    let email: string;
    let displayName: string | null | undefined;
    try {
      ({ tokens } = await client.getToken(q.data.code));
      client.setCredentials(tokens);

      // Identify the connected inbox.
      const oauth2 = (await import("googleapis")).google.oauth2({
        version: "v2",
        auth: client,
      });
      const me = await oauth2.userinfo.get();
      if (!me.data.email) throw new Error("Google returned no email");
      email = me.data.email;
      displayName = me.data.name;
    } catch (err) {
      req.log.warn({ err }, "inbox-connect OAuth exchange failed");
      return reply
        .code(400)
        .type("text/html")
        .send(
          `<html><body style="font-family:sans-serif;padding:2rem">Connection failed — the Google sign-in expired or was cancelled. Close this tab and try again.</body></html>`,
        );
    }

    await prisma.account.upsert({
      where: { email },
      update: {
        oauthRefreshEnc: tokens.refresh_token
          ? encrypt(tokens.refresh_token)
          : undefined,
        oauthAccessEnc: tokens.access_token
          ? encrypt(tokens.access_token)
          : undefined,
        oauthExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        oauthScope: tokens.scope,
        status: "active",
      },
      create: {
        email,
        displayName: displayName ?? email,
        oauthRefreshEnc: tokens.refresh_token
          ? encrypt(tokens.refresh_token)
          : null,
        oauthAccessEnc: tokens.access_token
          ? encrypt(tokens.access_token)
          : null,
        oauthExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        oauthScope: tokens.scope,
      },
    });

    return reply
      .type("text/html")
      .send(
        `<html><body style="font-family:sans-serif;padding:2rem">Connected <b>${escapeHtml(email)}</b>. You can close this tab.<script>setTimeout(()=>window.close(),1500)</script></body></html>`,
      );
  });

  // Per-inbox activity: outbound messages sent from this account, newest first.
  app.get("/api/accounts/:id/messages", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({
        take: z.coerce.number().int().min(1).max(500).default(100),
        skip: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const [total, sentCount, messages] = await Promise.all([
      prisma.message.count({ where: { accountId: id, direction: "out" } }),
      prisma.message.count({ where: { accountId: id, direction: "out", status: "sent" } }),
      prisma.message.findMany({
        where: { accountId: id, direction: "out" },
        orderBy: [{ sentAt: "desc" }, { scheduledAt: "desc" }],
        take: q.take,
        skip: q.skip,
        include: {
          lead: { select: { email: true, name: true } },
          campaign: { select: { name: true } },
        },
      }),
    ]);
    return { total, sentCount, messages };
  });

  // Update per-account settings (warmup volume, cold cap, pause/resume).
  app.patch("/api/accounts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        warmupVolumeManual: z.number().int().min(0).max(40).optional(),
        dailyCapCold: z.number().int().min(0).max(50).optional(),
        warmedUp: z.boolean().optional(),
        warmupEnabled: z.boolean().optional(),
        warmupTarget: z.number().int().min(0).max(2000).optional(),
        signature: z.string().max(2000).nullable().optional(),
        // Default send-as alias. Empty string from the UI is normalized to null.
        sendAsEmail: z
          .union([z.string().email(), z.literal(""), z.null()])
          .optional()
          .transform((v) => (v === "" ? null : v)),
        sendAsName: z.string().max(200).nullable().optional(),
        status: z.enum(["active", "paused", "quarantined"]).optional(),
        // Per-inbox scheduling controls (all nullable = clear the override).
        hourlyCap: z.number().int().min(1).max(60).nullable().optional(),
        minGapMinutes: z.number().int().min(1).max(240).nullable().optional(),
        sendWindows: z
          .array(
            z.object({
              startMin: z.number().int().min(0).max(1439),
              endMin: z.number().int().min(1).max(1440),
              weight: z.number().min(0).max(1),
            }).refine((w) => w.endMin > w.startMin, "endMin must be after startMin"),
          )
          .max(6)
          .nullable()
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const data: Record<string, unknown> = { ...body.data };
    // Map the API's `sendWindows` onto the DB column; null clears the override.
    if (body.data.sendWindows !== undefined) {
      delete (data as Record<string, unknown>).sendWindows;
      data.sendWindowsJson = body.data.sendWindows ?? Prisma.DbNull;
    }
    if (body.data.status === "active") data.pausedUntil = null;
    const acct = await prisma.account.update({
      where: { id: params.id },
      data,
    });
    await audit("account.update", acct.id, body.data as Record<string, unknown>);
    return { ok: true, id: acct.id };
  });

  // Manual pause / resume from the UI (distinct from a timed breaker pause).
  app.post("/api/accounts/:id/pause", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.account.update({ where: { id }, data: { status: "paused" } });
    await audit("account.pause", id);
    return { ok: true };
  });

  app.post("/api/accounts/:id/resume", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.account.update({
      where: { id },
      data: { status: "active", pausedUntil: null },
    });
    await audit("account.resume", id);
    return { ok: true };
  });

  // Disconnect: revoke the grant AT GOOGLE (so the refresh token dies there,
  // not just in our DB), then wipe the stored ciphertexts. Kept as a row (with
  // its history) but marked disconnected + paused.
  app.post("/api/accounts/:id/disconnect", { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const acct = await prisma.account.findUnique({
      where: { id },
      select: { oauthRefreshEnc: true },
    });
    if (acct?.oauthRefreshEnc) {
      try {
        const refreshToken = decrypt(acct.oauthRefreshEnc);
        // Best-effort: revoking the refresh token invalidates the whole grant.
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch (err) {
        // Still disconnect locally; the user can also revoke at
        // myaccount.google.com → Security → Third-party access.
        req.log.warn({ err }, "Google token revoke failed during disconnect");
      }
    }
    await prisma.account.update({
      where: { id },
      data: {
        oauthRefreshEnc: null,
        oauthAccessEnc: null,
        oauthExpiry: null,
        status: "paused",
      },
    });
    await audit("account.disconnect", id);
    return { ok: true };
  });

  // Delete: revoke the Google grant, cancel queued sends, detach leads, drop
  // the row. Message history survives (Message.accountId is set to null);
  // per-account SendLog stats cascade away with the account.
  app.delete("/api/accounts/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const acct = await prisma.account.findUnique({ where: { id } });
    if (!acct) return reply.code(404).send({ error: "not_found" });

    // Best-effort revoke at Google so the refresh token dies there too.
    if (acct.oauthRefreshEnc) {
      try {
        const refreshToken = decrypt(acct.oauthRefreshEnc);
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        });
      } catch (err) {
        req.log.warn({ err }, "Google token revoke failed during delete");
      }
    }

    // Cancel this inbox's still-queued BullMQ send jobs, then mark those
    // messages canceled so the planner doesn't resurrect them.
    const queued = await prisma.message.findMany({
      where: { accountId: id, direction: "out", status: { in: ["planned", "queued"] } },
      select: { id: true, bulljobId: true },
    });
    for (const m of queued) await cancelSendJob(m.bulljobId);
    await prisma.message.updateMany({
      where: { id: { in: queued.map((m) => m.id) } },
      data: { status: "canceled", bulljobId: null },
    });

    // Detach leads (they get reassigned by the planner's round-robin), then
    // delete. Message.accountId -> SetNull, SendLog -> Cascade (schema).
    await prisma.$transaction([
      prisma.lead.updateMany({ where: { accountId: id }, data: { accountId: null } }),
      prisma.account.delete({ where: { id } }),
    ]);

    await audit("account.delete", id, { email: acct.email, canceledSends: queued.length });
    return { ok: true, canceledSends: queued.length };
  });
}
