import crypto from "node:crypto";
import { env } from "./env.js";

/**
 * Signed open/click tracking tokens. Payload is base64url(JSON).signature so the
 * message id (and, for clicks, the target URL) can't be forged or tampered with.
 * Tracking is off by default per-campaign — pixels/redirects hurt deliverability.
 */
export interface TrackPayload {
  m: string; // messageId
  u?: string; // click target URL (clicks only)
}

function secret(): string {
  // Dedicated secret with a fallback so tracking links don't all break if the
  // session secret is rotated (see unsubscribe note).
  return process.env.TRACKING_SECRET || env.sessionSecret();
}

export function trackingToken(payload: TrackPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyTrackingToken(token: string): TrackPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TrackPayload;
  } catch {
    return null;
  }
}

export function openPixelUrl(messageId: string): string {
  return `${env.appBaseUrl}/o/${trackingToken({ m: messageId })}.gif`;
}

export function clickUrl(messageId: string, targetUrl: string): string {
  return `${env.appBaseUrl}/c/${trackingToken({ m: messageId, u: targetUrl })}`;
}

/** 1x1 transparent GIF bytes for the open pixel. */
export const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
