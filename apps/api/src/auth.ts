import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "@trickle/shared";
import { actorStorage } from "./audit.js";

const COOKIE = "trickle_session";
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 30 * 1000; // 30 days

function sign(value: string): string {
  const h = crypto
    .createHmac("sha256", env.sessionSecret())
    .update(value)
    .digest("base64url");
  return `${value}.${h}`;
}

/** Constant-time equality that never throws on mismatched lengths. */
export function safeEqual(a: string, b: string): boolean {
  // Hash both sides first so the comparison length never depends on input.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function verify(token: string): boolean {
  const idx = token.lastIndexOf(".");
  if (idx < 0) return false;
  const value = token.slice(0, idx);
  // Reject a forged/tampered signature — length-safe, never 500s on garbage.
  if (!safeEqual(sign(value), token)) return false;
  // Enforce server-side expiry: value is `u:<issuedAtMs>`.
  const issuedAt = Number(value.split(":")[1]);
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) return false;
  return true;
}

export function issueSession(reply: FastifyReply) {
  const value = `u:${Date.now()}`;
  reply.setCookie(COOKIE, sign(value), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.appBaseUrl.startsWith("https"),
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: "/" });
}

/**
 * Machine auth: `Authorization: Bearer <API_TOKEN>`.
 * Disabled entirely when API_TOKEN is unset/empty. Constant-time compare.
 * Successful bearer requests are audited as actor "api" (sessions are "user").
 */
function verifyBearer(req: FastifyRequest): boolean {
  const configured = env.apiToken();
  if (!configured) return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;
  return safeEqual(presented, configured);
}

/** Fastify preHandler: 401 unless a valid session cookie OR API bearer token is present. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (verifyBearer(req)) {
    // Propagate to the rest of this request's async chain so audit() rows
    // record actor: "api" without threading req through call sites.
    actorStorage.enterWith("api");
    return;
  }
  const token = req.cookies?.[COOKIE];
  if (!token || !verify(token)) {
    reply.code(401).send({ error: "unauthorized" });
  }
}
