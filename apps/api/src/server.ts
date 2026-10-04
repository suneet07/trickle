import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { env, assertEnv } from "@trickle/shared";
import authRoutes from "./routes/auth.js";
import accountRoutes from "./routes/accounts.js";
import leadRoutes from "./routes/leads.js";
import regionRoutes from "./routes/regions.js";
import campaignRoutes from "./routes/campaigns.js";
import dashboardRoutes from "./routes/dashboard.js";
import threadRoutes from "./routes/threads.js";
import suppressionRoutes from "./routes/suppressions.js";
import settingsRoutes from "./routes/settings.js";
import publicRoutes from "./routes/public.js";

assertEnv("api");

const app = Fastify({
  logger: { level: env.nodeEnv === "development" ? "info" : "warn" },
  // Behind a reverse proxy every request arrives from the proxy's IP. Trusting
  // X-Forwarded-For restores the real client IP so rate limits are
  // per-visitor. Set TRUST_PROXY=false when nothing sits in front of the app.
  trustProxy: env.trustProxy(),
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

// Global per-IP rate limit. Generous enough for normal SPA use, but stops
// token brute-forcing against the public endpoints (/u, /o, /c) and abuse of
// the OAuth start/callback routes.
await app.register(rateLimit, {
  max: 300, // requests per window per IP
  timeWindow: "1 minute",
  allowList: (req) => {
    // Never rate-limit the SPA's own static assets.
    const u = req.raw.url ?? "";
    return u.startsWith("/assets/") || u === "/" || u === "/index.html";
  },
});

// Security headers on every response (no extra dependency needed).
app.addHook("onSend", async (_req, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  if (env.appBaseUrl.startsWith("https")) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});

// API + public routes.
await app.register(authRoutes);
await app.register(accountRoutes);
await app.register(leadRoutes);
await app.register(regionRoutes);
await app.register(campaignRoutes);
await app.register(dashboardRoutes);
await app.register(threadRoutes);
await app.register(suppressionRoutes);
await app.register(settingsRoutes);
await app.register(publicRoutes);

// Serve the built SPA (apps/web/dist) if present; SPA fallback to index.html.
const webDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}

const port = env.apiPort;
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    // Always print this, whatever the log level: it is how people find the app.
    console.log(
      `Trickle API listening on :${port} — ${env.appBaseUrl} ` +
        `(${env.sendLive() ? "LIVE sending" : "dry-run: no email is actually sent"})`,
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
