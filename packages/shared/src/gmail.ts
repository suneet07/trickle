import crypto from "node:crypto";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { prisma, decrypt, encrypt } from "@trickle/db";
import { env, GMAIL_SCOPES } from "./env.js";

// Explicit return type so TS doesn't have to name google-auth-library's deep
// pnpm path (TS2742 "inferred type is not portable").
export function oauthClient(): InstanceType<typeof google.auth.OAuth2> {
  const g = env.google();
  return new google.auth.OAuth2(g.clientId, g.clientSecret, g.redirectUri);
}

export function consentUrl(state: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token
    scope: GMAIL_SCOPES,
    state,
  });
}

/**
 * Build an authenticated Gmail client for an account, refreshing the access
 * token as needed and persisting any rotated refresh token.
 */
export async function gmailFor(accountId: string): Promise<gmail_v1.Gmail> {
  const acct = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
  });
  if (!acct.oauthRefreshEnc) {
    throw new Error(`Account ${acct.email} has no OAuth refresh token`);
  }
  const client = oauthClient();
  client.setCredentials({
    refresh_token: decrypt(acct.oauthRefreshEnc),
    access_token: acct.oauthAccessEnc ? decrypt(acct.oauthAccessEnc) : undefined,
    expiry_date: acct.oauthExpiry?.getTime(),
  });

  // Persist rotated tokens.
  client.on("tokens", async (tokens) => {
    const data: Record<string, unknown> = {};
    if (tokens.access_token) data.oauthAccessEnc = encrypt(tokens.access_token);
    if (tokens.refresh_token)
      data.oauthRefreshEnc = encrypt(tokens.refresh_token);
    if (tokens.expiry_date) data.oauthExpiry = new Date(tokens.expiry_date);
    if (Object.keys(data).length) {
      await prisma.account.update({ where: { id: acct.id }, data }).catch(() => {});
    }
  });

  return google.gmail({ version: "v1", auth: client });
}

/**
 * Generate an RFC 5322 Message-ID for an outbound email, scoped to the sending
 * account's domain. Stored on the Message row so follow-ups can reference it.
 */
export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  const rand = crypto.randomBytes(16).toString("hex");
  return `<${Date.now()}.${rand}@${domain}>`;
}

/** RFC 2822 message, base64url-encoded for the Gmail send endpoint. */
export function buildRawEmail(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  unsubscribeUrl: string;
  html?: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const contentType = opts.html
    ? 'Content-Type: text/html; charset="UTF-8"'
    : 'Content-Type: text/plain; charset="UTF-8"';
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    contentType,
  ];
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`);
  // RFC 8058 one-click unsubscribe. Gmail/Yahoo bulk-sender rules require this,
  // and a valid List-Unsubscribe header improves complaint handling and inbox
  // placement rather than hurting it.
  if (opts.unsubscribeUrl) {
    headers.push(
      `List-Unsubscribe: <${opts.unsubscribeUrl}>`,
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    );
  }
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);

  const raw = `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
