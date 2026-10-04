import { prisma } from "@trickle/db";
import { env } from "./env.js";
import { gmailFor } from "./gmail.js";

/** Fire an alert to the configured channel and record an Event row. */
export async function alert(title: string, detail: string) {
  await prisma.event
    .create({ data: { type: "alert", payload: { title, detail } } })
    .catch(() => {});

  const cfg = env.alerts();

  if (cfg.channel === "telegram" && cfg.telegramToken && cfg.telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `[alert] ${title}\n${detail}` }),
      });
    } catch {
      /* best-effort */
    }
  } else if (cfg.channel === "email" && cfg.email) {
    await sendAlertEmail(cfg.email, title, detail).catch(() => {});
  } else if (cfg.channel === "webhook" && cfg.webhookUrl) {
    try {
      // `text` is read by Slack, `content` by Discord; generic endpoints get both.
      const text = `[Trickle] ${title}\n${detail}`;
      await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text, title, detail }),
      });
    } catch {
      /* best-effort */
    }
  }

  // eslint-disable-next-line no-console
  console.warn(`[ALERT] ${title} — ${detail}`);
}

/**
 * Send an operational alert email from the first connected inbox to
 * ALERT_EMAIL via the Gmail API. Operational alerts send regardless of
 * SEND_LIVE (they are not campaign traffic). Best-effort: silent if no inbox is
 * connected yet.
 */
async function sendAlertEmail(to: string, title: string, detail: string) {
  const account = await prisma.account.findFirst({
    where: { oauthRefreshEnc: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (!account) return; // no connected inbox yet

  const gmail = await gmailFor(account.id);
  const raw = Buffer.from(
    [
      `From: ${account.email}`,
      `To: ${to}`,
      `Subject: [Trickle alert] ${title}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      detail,
    ].join("\r\n"),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}
