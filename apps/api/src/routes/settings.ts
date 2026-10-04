import type { FastifyInstance } from "fastify";
import { prisma } from "@trickle/db";
import { env, loginMethods, checkSpfDkimDmarc } from "@trickle/shared";
import { requireAuth } from "../auth.js";

/**
 * Read-only view of the effective configuration, for the Settings page and the
 * dry-run banner. Configuration itself lives in the environment (.env); nothing
 * secret is ever returned here.
 */
export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/config", { preHandler: requireAuth }, async () => {
    const sender = env.sender();
    return {
      version: process.env.APP_VERSION ?? "dev",
      appBaseUrl: env.appBaseUrl,
      sendLive: env.sendLive(),
      globalDailyCap: env.globalDailyCap(),
      perInboxTotalCap: env.perInboxTotalCap(),
      holidayCalendar: env.holidayCalendar(),
      defaultTimezone: env.defaultTimezone(),
      sender,
      senderFooterConfigured: !!(sender.senderName || sender.company),
      googleConfigured: env.googleConfigured(),
      loginMethods: loginMethods(),
      apiTokenEnabled: !!env.apiToken(),
      alertChannel: env.alerts().channel,
    };
  });

  // DNS authentication check for every sending domain in use (SPF + DMARC).
  app.get("/api/config/dns", { preHandler: requireAuth }, async () => {
    const accounts = await prisma.account.findMany({ select: { email: true, sendAsEmail: true } });
    const domains = [
      ...new Set(
        accounts
          .flatMap((a) => [a.email, a.sendAsEmail])
          .filter((e): e is string => !!e)
          .map((e) => e.split("@")[1]!.toLowerCase()),
      ),
    ];
    return Promise.all(
      domains.map(async (domain) => ({ domain, ...(await checkSpfDkimDmarc(domain)) })),
    );
  });
}
