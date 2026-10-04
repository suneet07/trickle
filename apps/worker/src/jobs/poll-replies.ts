import { prisma } from "@trickle/db";
import { gmailFor, env, alert } from "@trickle/shared";
import { bumpSendLog } from "../lib.js";
import { cancelFollowUps } from "./followups.js";

/**
 * poll-replies: every 10 min per account, scan recent inbox messages.
 *  - A reply on one of our threads -> lead Replied, cancel follow-ups, record.
 *  - A mailer-daemon bounce -> lead Bounced + Suppression, breaker check.
 * In dry-run there is nothing to poll.
 */
export async function processPollReplies(accountId: string) {
  if (!env.sendLive()) return;

  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  if (!account.oauthRefreshEnc) return;
  const gmail = await gmailFor(accountId);

  // Fetch recent messages in the last day (newer_than:1d), inbox only.
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "newer_than:1d in:inbox",
    maxResults: 50,
  });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);

  for (const id of ids) {
    const full = await gmail.users.messages.get({ userId: "me", id, format: "metadata" });
    const threadId = full.data.threadId ?? undefined;
    const headers = full.data.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
    const from = hdr("from");
    const subject = hdr("subject");
    const autoSubmitted = hdr("auto-submitted");
    const precedence = hdr("precedence");

    const isBounce =
      /mailer-daemon|postmaster/i.test(from) ||
      /delivery status notification|undeliverable|delivery failure|returned mail/i.test(subject);

    // Auto-reply / out-of-office detection. These are extremely common and must
    // NOT count as genuine replies — otherwise they mark the lead `replied`,
    // cancel follow-ups, and inflate reply-rate (and thus the health score).
    const isAutoReply =
      // RFC 3834: anything but "no" means it was machine-generated.
      (!!autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
      /auto[-_]?reply|auto[-_]?generated|bulk/i.test(precedence) ||
      /out of (the )?office|automatic reply|auto[- ]?reply|on vacation|away from|currently (out|away)|maternity leave|no longer with/i.test(
        subject,
      );

    // Match to one of our outbound threads.
    const outbound = threadId
      ? await prisma.message.findFirst({
          where: { gmailThreadId: threadId, direction: "out" },
          include: { lead: true },
        })
      : null;

    if (isBounce) {
      // Try to extract the failed recipient from the outbound thread.
      if (outbound?.lead) {
        await handleBounce(accountId, outbound.id, outbound.lead.id, outbound.lead.email);
      }
      continue;
    }

    // Skip auto-replies: record nothing, don't touch lead status or follow-ups.
    if (isAutoReply) continue;

    if (outbound && !/no-reply|noreply/i.test(from)) {
      // Genuine reply.
      const exists = await prisma.message.findFirst({
        where: { gmailMsgId: id, direction: "in" },
      });
      if (exists) continue;
      // Gmail snippets are HTML-entity-encoded; store decoded text.
      const snippet = (full.data.snippet ?? "").replace(
        /&(lt|gt|amp|quot|#39|apos|nbsp);/g,
        (m, e: string) =>
          ({ lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", apos: "'", nbsp: " " })[e] ?? m,
      );
      await prisma.message.create({
        data: {
          direction: "in",
          status: "sent",
          stepIndex: 0,
          subject,
          body: snippet,
          gmailThreadId: threadId,
          gmailMsgId: id,
          leadId: outbound.leadId,
          campaignId: outbound.campaignId,
          accountId,
          sentAt: new Date(),
        },
      });

      // Content-based opt-out: a human replying "STOP" / "remove me" / "unsubscribe"
      // is a suppression request, not just a reply. Treat it as an unsubscribe so
      // a person doesn't have to notice it manually (compliance).
      const optOut =
        /\b(unsubscribe|stop|remove me|take me off|opt.?out|do not (contact|email)|no longer|not interested|no interest)\b/i.test(
          `${subject} ${snippet}`,
        );
      if (optOut) {
        await prisma.$transaction([
          prisma.suppression.upsert({
            where: { email: outbound.lead.email },
            update: {},
            create: { email: outbound.lead.email, reason: "unsub", detail: "reply opt-out" },
          }),
          prisma.lead.update({ where: { id: outbound.leadId }, data: { status: "unsubscribed" } }),
        ]);
        await cancelFollowUps(outbound.leadId);
        await prisma.event.create({
          data: { type: "reply_optout", payload: { leadId: outbound.leadId } },
        });
      } else {
        await prisma.lead.update({
          where: { id: outbound.leadId },
          data: { status: "replied" },
        });
        await cancelFollowUps(outbound.leadId);
      }
      await bumpSendLog(accountId, "replies");
    }
  }
}

async function handleBounce(
  accountId: string,
  messageId: string,
  leadId: string,
  email: string,
) {
  await prisma.$transaction([
    // Mark the originating message bounced so the campaign dashboard's
    // `status = "bounced"` counts are accurate.
    prisma.message.update({ where: { id: messageId }, data: { status: "bounced" } }),
    prisma.lead.update({ where: { id: leadId }, data: { status: "bounced" } }),
    prisma.suppression.upsert({
      where: { email },
      update: {},
      create: { email, reason: "bounce" },
    }),
  ]);
  await cancelFollowUps(leadId);
  await bumpSendLog(accountId, "bounces");

  // Bounce breaker: hard bounces >=2 today -> pause account 48h.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const log = await prisma.sendLog.findUnique({
    where: { accountId_date: { accountId, date: today } },
  });
  if ((log?.bounces ?? 0) >= 2) {
    await prisma.account.update({
      where: { id: accountId },
      data: { pausedUntil: new Date(Date.now() + 48 * 3600_000) },
    });
    const acct = await prisma.account.findUnique({ where: { id: accountId }, select: { email: true } });
    await alert(
      "Inbox auto-paused",
      `${acct?.email ?? accountId} hit 2+ bounces today; cold sending paused for 48h.`,
    );
  }
}
