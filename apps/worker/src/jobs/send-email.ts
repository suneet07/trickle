import { DateTime } from "luxon";
import { prisma } from "@trickle/db";
import {
  gmailFor,
  buildRawEmail,
  generateMessageId,
  unsubscribeUrl,
  openPixelUrl,
  clickUrl,
  env,
  alert,
} from "@trickle/shared";
import { composeBody } from "@trickle/core";
import { bumpSendLog } from "../lib.js";
import { scheduleFollowUps } from "./followups.js";

/** Rewrite href="http..." links to the signed click-tracking redirect. */
function rewriteLinksForTracking(html: string, messageId: string): string {
  return html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (_m, url: string) => `href="${clickUrl(messageId, url)}"`,
  );
}

/**
 * send-email job. Suppression is checked before EVERY send. In dry-run
 * (SEND_LIVE=false) we record the send without calling Gmail.
 * Circuit breakers: 429/quota -> throw for BullMQ backoff; persistent -> pause.
 */
export async function processSend(messageId: string) {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { lead: true, account: true, campaign: true },
  });
  if (!msg) return;
  if (msg.status === "sent" || msg.status === "canceled") return;

  // Sending inbox was deleted — orphaned message can never send.
  const account = msg.account;
  if (!account) {
    await prisma.message.update({ where: { id: msg.id }, data: { status: "canceled" } });
    return;
  }
  const accountId = account.id;

  // Account paused/quarantined? Defer by re-planning (do not send).
  if (
    account.status !== "active" ||
    (account.pausedUntil && account.pausedUntil > new Date())
  ) {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "planned", bulljobId: null },
    });
    return;
  }

  // Campaign paused/finished? A queued job from before the pause must not send.
  // Reset to `planned` (not canceled) so the planner re-slots it on resume.
  // (One-off sends have no campaign and are unaffected.)
  if (msg.campaign && msg.campaign.status !== "running") {
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "planned", bulljobId: null },
    });
    return;
  }

  // Suppression check — ALWAYS, before every send, no exceptions.
  const supp = await prisma.suppression.findUnique({ where: { email: msg.lead.email } });
  if (supp) {
    await prisma.message.update({ where: { id: msg.id }, data: { status: "canceled" } });
    return;
  }
  // Hard blocks apply to everyone; a manual reply may still go to a lead whose
  // status is `replied`/`contacted` (that's the whole point of replying back).
  const blocking = msg.isManualReply
    ? ["unsubscribed", "bounced", "do_not_contact"]
    : ["unsubscribed", "bounced", "do_not_contact", "replied"];
  if (blocking.includes(msg.lead.status)) {
    await prisma.message.update({ where: { id: msg.id }, data: { status: "canceled" } });
    return;
  }

  const sender = env.sender();
  // Toggles come from the campaign when there is one; one-off sends carry
  // their own per-message toggles (all default off = person-to-person look).
  const isHtml = msg.campaign?.isHtml ?? msg.isHtml;
  const trackOpens = msg.campaign?.trackOpens ?? msg.trackOpens;
  const trackClicks = msg.campaign?.trackClicks ?? msg.trackClicks;
  const wantsUnsubHeader = msg.campaign?.unsubHeader ?? msg.unsubHeader;
  const unsub = wantsUnsubHeader ? unsubscribeUrl(msg.lead.email) : "";

  // Compose: body + optional per-inbox signature, then click tracking (which
  // only rewrites links in the content, never the footer), then the footer.
  let content = composeBody({
    body: msg.body,
    isHtml,
    signature: account.signature,
    footerOverride: "",
    sender,
  });
  if (isHtml && trackClicks) {
    content = rewriteLinksForTracking(content, msg.id);
  }
  // Footer: null = default sender footer; "" = none; text = custom footer.
  // Message-level override wins, then campaign-level, then the default.
  const footerOverride = msg.footerOverride ?? msg.campaign?.footerOverride ?? null;
  let body = composeBody({ body: content, isHtml, footerOverride, sender });
  if (isHtml && trackOpens) {
    body += `<img src="${openPixelUrl(msg.id)}" width="1" height="1" alt="" style="display:none">`;
  }

  // Dry-run mode: record without calling Gmail.
  if (!env.sendLive()) {
    await prisma.message.update({
      where: { id: msg.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        rfcMessageId: generateMessageId(account.email),
        gmailMsgId: `dryrun-${msg.id}`,
        gmailThreadId: msg.gmailThreadId ?? `dryrun-thread-${msg.leadId}`,
      },
    });
    await afterSend(msg.id);
    return;
  }

  // Thread follow-ups AND manual replies against prior sends using real RFC
  // Message-IDs (Gmail's threadId alone does NOT make the recipient's client
  // thread the conversation). Build the References chain from prior sent
  // messages to this lead.
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let subject = msg.subject;
  const isThreaded = msg.stepIndex > 0 || msg.isManualReply || !!msg.gmailThreadId;
  if (isThreaded) {
    const priors = await prisma.message.findMany({
      where: {
        leadId: msg.leadId,
        direction: "out",
        status: "sent",
        rfcMessageId: { not: null },
        id: { not: msg.id },
      },
      orderBy: { sentAt: "asc" },
      select: { rfcMessageId: true },
    });
    const ids = priors.map((p) => p.rfcMessageId!).filter(Boolean);
    if (ids.length) {
      inReplyTo = ids[ids.length - 1];
      references = ids.join(" ");
      if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;
    }
  }

  // Use the mailbox's default send-as alias if configured, else its primary
  // address. The alias must be a verified "Send mail as" on the Gmail account.
  const fromEmail = account.sendAsEmail || account.email;
  const fromHeader = account.sendAsName
    ? `${account.sendAsName} <${fromEmail}>`
    : fromEmail;
  // Keep the Message-ID domain aligned with the From domain (helps DKIM/DMARC).
  const rfcMessageId = generateMessageId(fromEmail);

  try {
    const gmail = await gmailFor(accountId);
    const raw = buildRawEmail({
      from: fromHeader,
      to: msg.lead.email,
      subject,
      body,
      unsubscribeUrl: unsub,
      html: isHtml,
      messageId: rfcMessageId,
      inReplyTo,
      references,
    });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: msg.gmailThreadId ?? undefined },
    });
    await prisma.message.update({
      where: { id: msg.id },
      data: {
        status: "sent",
        sentAt: new Date(),
        rfcMessageId,
        gmailMsgId: res.data.id ?? null,
        gmailThreadId: res.data.threadId ?? msg.gmailThreadId,
      },
    });
    await afterSend(msg.id);
  } catch (err: any) {
    const code = err?.code ?? err?.response?.status;
    await bumpSendLog(accountId, "gmailErr");
    await prisma.message.update({
      where: { id: msg.id },
      data: { error: String(err?.message ?? err).slice(0, 500) },
    });
    // 429/quota -> throw so BullMQ retries with backoff.
    if (code === 429 || code === 403) {
      throw err;
    }
    await prisma.message.update({ where: { id: msg.id }, data: { status: "failed" } });
    await alert("Send failed", `${account.email} -> ${msg.lead.email}: ${err?.message}`);
  }
}

/** Post-send bookkeeping: counters, lead status, follow-up scheduling. */
async function afterSend(messageId: string) {
  const msg = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: { campaign: true },
  });
  if (!msg.accountId) return; // inbox deleted between send and bookkeeping
  await bumpSendLog(msg.accountId, "coldSent");

  // Manual replies thread into the conversation but don't drive the sequence
  // or reset the lead's status (e.g. a reply to a `replied` lead stays replied).
  if (msg.isManualReply) return;

  if (msg.stepIndex === 0) {
    // Initial send: advance lead to contacted only from `pending` (don't regress
    // a lead that already replied/etc.), and schedule follow-ups.
    await prisma.lead.updateMany({
      where: { id: msg.leadId, status: "pending" },
      data: { status: "contacted" },
    });
    if (msg.campaign) await scheduleFollowUps(msg.id);
  } else {
    await prisma.lead.update({
      where: { id: msg.leadId },
      data: { status: "followup" },
    });
  }
}
