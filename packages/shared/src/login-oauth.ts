import { google } from "googleapis";
import { env, LOGIN_SCOPES } from "./env.js";

/**
 * OAuth2 client used for *login* (identity) only. Separate from the Gmail-inbox
 * connect client so the two flows use independent redirect URIs and never
 * interfere. Explicit return type avoids TS2742 (non-portable inferred type).
 */
export function loginOauthClient(): InstanceType<typeof google.auth.OAuth2> {
  const g = env.googleLogin();
  return new google.auth.OAuth2(g.clientId, g.clientSecret, g.redirectUri);
}

/**
 * Build the Google consent URL for signing in. When every allowed login shares
 * one domain, `hd` hints Google to offer only accounts on it. That is a UX hint
 * only; the verified ID token is checked server-side, never the hint.
 */
export function loginConsentUrl(state: string): string {
  const domains = new Set(
    env.allowedLoginEmails().map((rule) => rule.slice(rule.lastIndexOf("@") + 1)),
  );
  const consumer = ["gmail.com", "googlemail.com"];
  const domain =
    domains.size === 1 && !consumer.includes([...domains][0]!) ? [...domains][0] : undefined;
  return loginOauthClient().generateAuthUrl({
    access_type: "online", // login doesn't need offline/refresh tokens
    prompt: "select_account",
    scope: LOGIN_SCOPES,
    state,
    ...(domain ? { hd: domain } : {}),
  });
}

/**
 * Exchange an auth code for tokens and return the *verified* identity from the
 * ID token. Verifying the ID token (signature + audience) is what makes the
 * email trustworthy — we never take the email from an unsigned source.
 */
export async function verifyLoginCode(
  code: string,
): Promise<{ email: string; emailVerified: boolean } | null> {
  const client = loginOauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) return null;

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.googleLogin().clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) return null;

  return {
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
  };
}
