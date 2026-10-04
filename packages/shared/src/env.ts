/** Centralized, validated environment access. */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const appBaseUrl = opt("APP_BASE_URL", "http://localhost:8080").replace(/\/+$/, "");

export type AlertChannel = "none" | "email" | "telegram" | "webhook";

export const env = {
  nodeEnv: opt("NODE_ENV", "development"),
  appBaseUrl,
  apiPort: num("PORT", num("API_PORT", 8080)),
  // Trust X-Forwarded-For from a reverse proxy (Caddy, nginx, a tunnel) so
  // rate limits apply per real visitor. Disable when the app is exposed
  // directly to the internet with no proxy in front.
  trustProxy: () => bool("TRUST_PROXY", true),

  databaseUrl: () => req("DATABASE_URL"),
  redisUrl: () => opt("REDIS_URL", "redis://localhost:6379"),

  sessionSecret: () => req("SESSION_SECRET"),

  // Optional static bearer token for scripts and automation. Requests with
  // `Authorization: Bearer <token>` pass auth and are audited as actor "api".
  // Empty = the bearer path is disabled entirely.
  apiToken: () => opt("API_TOKEN", ""),

  // Who may sign in with Google. Entries are exact addresses
  // ("you@company.com") or whole domains ("@company.com").
  allowedLoginEmails: () => list("ALLOWED_LOGIN_EMAILS"),

  // Optional password sign-in, for setups without Google login.
  adminPassword: () => opt("ADMIN_PASSWORD", ""),

  googleConfigured: () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,

  google: () => ({
    clientId: req("GOOGLE_CLIENT_ID"),
    clientSecret: req("GOOGLE_CLIENT_SECRET"),
    redirectUri: opt("GOOGLE_REDIRECT_URI", `${appBaseUrl}/api/accounts/oauth/callback`),
  }),

  // Login uses the same Google client but its own redirect URI, so the sign-in
  // flow never collides with the connect-a-sending-inbox flow.
  googleLogin: () => ({
    clientId: req("GOOGLE_CLIENT_ID"),
    clientSecret: req("GOOGLE_CLIENT_SECRET"),
    redirectUri: opt("GOOGLE_LOGIN_REDIRECT_URI", `${appBaseUrl}/api/auth/google/callback`),
  }),

  sendLive: () => bool("SEND_LIVE", false),
  globalDailyCap: () => num("GLOBAL_DAILY_CAP", 100),
  perInboxTotalCap: () => num("PER_INBOX_TOTAL_CAP", 40),

  // "us" skips US federal holidays when planning; "none" disables skipping.
  holidayCalendar: (): "us" | "none" => (opt("HOLIDAY_CALENDAR", "us") === "none" ? "none" : "us"),
  // Timezone for leads with no explicit timezone, region or US state.
  defaultTimezone: () => opt("DEFAULT_TIMEZONE", "America/Los_Angeles"),

  sender: () => ({
    senderName: opt("SENDER_NAME", ""),
    title: opt("SENDER_TITLE", ""),
    company: opt("SENDER_COMPANY", ""),
    postalAddress: opt("SENDER_POSTAL_ADDRESS", ""),
  }),

  alerts: () => ({
    channel: opt("ALERT_CHANNEL", "none") as AlertChannel,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
    email: process.env.ALERT_EMAIL ?? "",
    // Slack / Discord / any endpoint accepting a JSON POST.
    webhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
  }),
};

/** Login methods enabled by the current configuration. */
export function loginMethods(): { google: boolean; password: boolean } {
  return {
    google: env.googleConfigured() && env.allowedLoginEmails().length > 0,
    password: env.adminPassword().length > 0,
  };
}

/** True when `email` matches an ALLOWED_LOGIN_EMAILS entry (address or @domain). */
export function isAllowedLoginEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return env.allowedLoginEmails().some((rule) =>
    rule.startsWith("@") ? e.endsWith(rule) : e === rule,
  );
}

/**
 * Check configuration at boot. Returns fatal errors (the process should not
 * start) and warnings (it can run, but something will not work).
 */
export function checkEnv(service: "api" | "worker"): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const gen = "Generate one with: openssl rand -hex 32";

  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL is not set.");

  const key = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    errors.push(`TOKEN_ENCRYPTION_KEY must be 64 hex characters. ${gen}`);
  } else if (/^0+$/.test(key)) {
    errors.push(`TOKEN_ENCRYPTION_KEY is the all-zero placeholder. ${gen}`);
  }

  const session = process.env.SESSION_SECRET ?? "";
  if (session.length < 32 || /change-me/i.test(session)) {
    errors.push(`SESSION_SECRET must be a random string of at least 32 characters. ${gen}`);
  }

  const tracking = process.env.TRACKING_SECRET ?? "";
  if (!tracking || /change-me/i.test(tracking)) {
    warnings.push(
      "TRACKING_SECRET is not set; unsubscribe and tracking links fall back to SESSION_SECRET " +
        "and would break if you ever rotate it.",
    );
  }

  if (!env.googleConfigured()) {
    warnings.push(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set; Gmail inboxes cannot be connected.",
    );
  }

  if (service === "api") {
    const m = loginMethods();
    if (!m.google && !m.password) {
      errors.push(
        "No way to sign in. Set ALLOWED_LOGIN_EMAILS (with Google OAuth credentials) " +
          "and/or ADMIN_PASSWORD.",
      );
    }
    if (m.password && env.adminPassword().length < 12) {
      warnings.push("ADMIN_PASSWORD is shorter than 12 characters.");
    }
  }

  return { errors, warnings };
}

/** Print config problems and exit on fatal ones. Call once at process start. */
export function assertEnv(service: "api" | "worker"): void {
  const { errors, warnings } = checkEnv(service);
  for (const w of warnings) console.warn(`[config] warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[config] error: ${e}`);
    console.error("[config] Fix the values above in your .env file and restart.");
    process.exit(1);
  }
}

export const GMAIL_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

// Login only needs identity, no Gmail scopes. Gmail access is granted
// separately when a sending inbox is connected.
export const LOGIN_SCOPES = ["openid", "email", "profile"];
