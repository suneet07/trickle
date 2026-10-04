import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  env,
  isAllowedLoginEmail,
  loginConsentUrl,
  loginMethods,
  verifyLoginCode,
} from "@trickle/shared";
import { clearSession, issueSession, requireAuth, safeEqual } from "../auth.js";
import { audit } from "../audit.js";

// Short-lived cookie holding a random CSRF nonce for the OAuth round-trip.
// We compare it against the `state` Google echoes back (double-submit),
// preventing login CSRF / code-injection from a forged callback.
const STATE_COOKIE = "g_oauth_state";
const STATE_MAX_AGE_S = 600; // 10 minutes

function secureCookie(): boolean {
  return env.appBaseUrl.startsWith("https");
}

export default async function authRoutes(app: FastifyInstance) {
  // Lightweight session check — no DB access, so the auth probe never 500s.
  app.get("/api/auth/me", { preHandler: requireAuth }, async () => ({ ok: true }));

  // Public: which sign-in options the login screen should offer.
  app.get("/api/auth/methods", async () => loginMethods());

  // Password sign-in (only when ADMIN_PASSWORD is set). Tight rate limit on
  // top of the global one, to make online guessing impractical.
  app.post(
    "/api/auth/password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const configured = env.adminPassword();
      if (!configured) return reply.code(404).send({ error: "not_enabled" });
      const body = z.object({ password: z.string().min(1).max(512) }).safeParse(req.body);
      if (!body.success || !safeEqual(body.data.password, configured)) {
        return reply.code(401).send({ error: "invalid_password", message: "Wrong password." });
      }
      issueSession(reply);
      await audit("auth.login", undefined, { method: "password" });
      return { ok: true };
    },
  );

  // Step 1: start Google login. Sets the CSRF-state cookie and 302s to Google.
  app.get("/api/auth/google/start", async (_req, reply) => {
    if (!loginMethods().google) return reply.redirect("/?auth_error=google_disabled");
    const state = crypto.randomBytes(32).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: secureCookie(),
      maxAge: STATE_MAX_AGE_S,
    });
    return reply.redirect(loginConsentUrl(state));
  });

  // Step 2: Google redirects the browser back here (no auth preHandler — the
  // user isn't logged in yet). We verify state, verify the ID token, and only
  // issue a session if the verified email is on the allowlist.
  app.get("/api/auth/google/callback", async (req, reply) => {
    const q = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .safeParse(req.query);

    if (!q.success || q.data.error || !q.data.code || !q.data.state) {
      return reply.redirect("/?auth_error=cancelled");
    }

    // CSRF: the state param must match the cookie we set in step 1.
    const cookieState = req.cookies?.[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (!cookieState || cookieState !== q.data.state) {
      return reply.redirect("/?auth_error=state");
    }

    let identity: { email: string; emailVerified: boolean } | null = null;
    try {
      identity = await verifyLoginCode(q.data.code);
    } catch {
      return reply.redirect("/?auth_error=verify");
    }

    // Enforce: verified email AND an allowlist match. Both required.
    if (!identity || !identity.emailVerified || !isAllowedLoginEmail(identity.email)) {
      return reply.redirect("/?auth_error=not_allowed");
    }

    issueSession(reply);
    await audit("auth.login", undefined, { method: "google", email: identity.email });
    return reply.redirect("/");
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });
}
