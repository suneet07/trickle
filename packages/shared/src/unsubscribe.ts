import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * Signed unsubscribe token so links can't be forged. token = base64url(email).sig
 *
 * Signed with TRACKING_SECRET (NOT the session secret) so that rotating
 * SESSION_SECRET — the documented remedy for a leaked cookie — never breaks
 * unsubscribe links in already-sent emails (they must keep working). Falls back to SESSION_SECRET only if TRACKING_SECRET is unset.
 */
function secret(): string {
  return process.env.TRACKING_SECRET || env.sessionSecret();
}

export function unsubscribeToken(email: string): string {
  const payload = Buffer.from(email).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return Buffer.from(payload, "base64url").toString("utf8");
}

export function unsubscribeUrl(email: string): string {
  return `${env.appBaseUrl}/u/${unsubscribeToken(email)}`;
}
