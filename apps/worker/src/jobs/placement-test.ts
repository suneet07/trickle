import { prisma } from "@trickle/db";
import {
  gmailFor,
  buildRawEmail,
  generateMessageId,
  unsubscribeUrl,
  env,
  placementQueue,
} from "@trickle/shared";
import { renderTemplate, composeBody } from "@trickle/core";

/**
 * Built-in inbox placement test (free, Gmail-only seeds).
 *
 * Send phase: render the campaign's real subject/body (same footer and
 * signature handling as a live send) and send one copy from EVERY active
 * connected inbox to every OTHER connected inbox (the seeds). Each copy gets a
 * unique RFC Message-ID which is stored so the checker can find it precisely
 * (rfc822msgid: search) without a subject tag that would skew filtering.
 *
 * Check phase (delayed ~3 min): for each seed, look the message up WITH
 * includeSpamTrash and classify by labels:
 *   SPAM -> "spam", CATEGORY_PROMOTIONS -> "promotions", INBOX -> "inbox",
 *   not found -> "missing".
 *
 * Pure observation — never rescue/label anything (that would poison the test).
 * Results are advisory only (warn, never block launch).
 */

export interface PlacementJobData {
  placementTestId: string;
  phase: "send" | "check";
}

export interface PlacementPair {
  sender: string; // From address actually used (alias if configured)
  seed: string;
  rfcMessageId: string;
  folder: "pending" | "inbox" | "spam" | "promotions" | "missing" | "send_failed";
  error?: string;
}

// 5 min: delivery is fast but Gmail's search index can lag a few minutes.
const CHECK_DELAY_MS = 5 * 60_000;

// Neutral sample vars so {{merge}} fields render like a real send.
const SAMPLE_VARS = {
  name: "Alex",
  company: "Acme Inc",
  city: "Springfield",
  state: "IL",
  title: "Head of Operations",
  email: "seed@example.com",
};

export async function processPlacementTest(data: PlacementJobData) {
  if (data.phase === "send") return sendPhase(data.placementTestId);
  return checkPhase(data.placementTestId);
}

async function sendPhase(testId: string) {
  const test = await prisma.placementTest.findUnique({
    where: { id: testId },
    include: { campaign: true },
  });
  if (!test || test.status !== "pending") return;

  if (!env.sendLive()) {
    await prisma.placementTest.update({
      where: { id: testId },
      data: { status: "error", error: "SEND_LIVE=false (dry-run) — cannot placement-test" },
    });
    return;
  }

  const accounts = await prisma.account.findMany({
    where: { status: "active", oauthRefreshEnc: { not: null } },
  });
  if (accounts.length < 2) {
    await prisma.placementTest.update({
      where: { id: testId },
      data: { status: "error", error: "Need at least 2 connected active inboxes" },
    });
    return;
  }

  const c = test.campaign;
  const identity = env.sender();
  const pairs: PlacementPair[] = [];

  for (const sender of accounts) {
    const fromEmail = sender.sendAsEmail || sender.email;
    const fromHeader = sender.sendAsName ? `${sender.sendAsName} <${fromEmail}>` : fromEmail;

    // Compose exactly like a live send: template + signature + footer.
    const subject = renderTemplate(c.subjectTemplate, SAMPLE_VARS);
    const body = composeBody({
      body: renderTemplate(c.bodyTemplate, SAMPLE_VARS),
      isHtml: c.isHtml,
      signature: sender.signature,
      footerOverride: c.footerOverride,
      sender: identity,
    });

    let gmail;
    try {
      gmail = await gmailFor(sender.id);
    } catch (err: any) {
      for (const seed of accounts.filter((p) => p.id !== sender.id)) {
        pairs.push({
          sender: fromEmail,
          seed: seed.email,
          rfcMessageId: "",
          folder: "send_failed",
          error: String(err?.message ?? err).slice(0, 200),
        });
      }
      continue;
    }

    for (const seed of accounts.filter((p) => p.id !== sender.id)) {
      const rfcMessageId = generateMessageId(fromEmail);
      try {
        const raw = buildRawEmail({
          from: fromHeader,
          to: seed.email,
          subject,
          body,
          html: c.isHtml,
          unsubscribeUrl: c.unsubHeader ? unsubscribeUrl(seed.email) : "",
          messageId: rfcMessageId,
        });
        await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
        pairs.push({ sender: fromEmail, seed: seed.email, rfcMessageId, folder: "pending" });
      } catch (err: any) {
        pairs.push({
          sender: fromEmail,
          seed: seed.email,
          rfcMessageId,
          folder: "send_failed",
          error: String(err?.message ?? err).slice(0, 200),
        });
      }
    }
  }

  await prisma.placementTest.update({
    where: { id: testId },
    data: { status: "sent", resultsJson: pairs as unknown as object },
  });

  await placementQueue.add(
    "check",
    { placementTestId: testId, phase: "check" } satisfies PlacementJobData,
    { delay: CHECK_DELAY_MS, removeOnComplete: true },
  );
}

async function checkPhase(testId: string) {
  const test = await prisma.placementTest.findUnique({ where: { id: testId } });
  if (!test || test.status !== "sent") return;

  const pairs = (test.resultsJson as unknown as PlacementPair[]) ?? [];
  const seedAccounts = await prisma.account.findMany({
    where: { oauthRefreshEnc: { not: null } },
  });
  const byEmail = new Map(seedAccounts.map((a) => [a.email.toLowerCase(), a]));
  const gmailCache = new Map<string, Awaited<ReturnType<typeof gmailFor>>>();

  for (const pair of pairs) {
    if (pair.folder !== "pending") continue;
    const seedAcc = byEmail.get(pair.seed.toLowerCase());
    if (!seedAcc) {
      pair.folder = "missing";
      continue;
    }
    try {
      let gmail = gmailCache.get(seedAcc.id);
      if (!gmail) {
        gmail = await gmailFor(seedAcc.id);
        gmailCache.set(seedAcc.id, gmail);
      }
      // Gmail rewrites custom Message-IDs on API sends, so rfc822msgid: search
      // is unreliable. Instead: recent mail from the sender (includeSpamTrash
      // is essential — the default search skips the spam folder), then match
      // the Message-ID header if preserved, else take the newest candidate.
      const found = await gmail.users.messages.list({
        userId: "me",
        q: `from:${pair.sender} newer_than:1d`,
        includeSpamTrash: true,
        maxResults: 10,
      });
      const ids = (found.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      if (ids.length === 0) {
        pair.folder = "missing";
        continue;
      }

      let chosen: { labels: string[] } | null = null;
      let newest: { labels: string[]; internalDate: number } | null = null;
      for (const id of ids) {
        const full = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Message-ID"],
        });
        const labels = full.data.labelIds ?? [];
        const hdr =
          full.data.payload?.headers?.find(
            (h) => h.name?.toLowerCase() === "message-id",
          )?.value ?? "";
        if (hdr && hdr === pair.rfcMessageId) {
          chosen = { labels };
          break; // exact match wins
        }
        const ts = Number(full.data.internalDate ?? 0);
        if (!newest || ts > newest.internalDate) newest = { labels, internalDate: ts };
      }
      const labels = (chosen ?? newest)?.labels ?? [];
      if (labels.includes("SPAM")) pair.folder = "spam";
      else if (labels.includes("CATEGORY_PROMOTIONS")) pair.folder = "promotions";
      else if (labels.includes("INBOX")) pair.folder = "inbox";
      else pair.folder = "missing";
    } catch {
      pair.folder = "missing";
    }
  }

  await prisma.placementTest.update({
    where: { id: testId },
    data: { status: "done", checkedAt: new Date(), resultsJson: pairs as unknown as object },
  });

  const spam = pairs.filter((p) => p.folder === "spam").length;
  await prisma.event.create({
    data: {
      type: "placement_test_done",
      payload: { placementTestId: testId, campaignId: test.campaignId, total: pairs.length, spam },
    },
  });
}
