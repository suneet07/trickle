import { prisma } from "@trickle/db";
import { gmailFor, buildRawEmail, generateMessageId, env } from "@trickle/shared";
import { bumpSendLog } from "../lib.js";

/**
 * Built-in warmup automation. For each warmup-enabled, connected inbox that
 * hasn't hit its target, send a few benign peer-to-peer emails to other
 * warmup-enabled inboxes; on the receiving side, rescue the message from spam
 * and mark it read/important so the provider learns the sender is wanted.
 *
 * Counters (warmupSentTotal, SendLog.warmupSent) track progress; once an inbox
 * reaches warmupTarget it's marked warmedUp and drops out of the pool. In
 * dry-run we only advance the counters (no Gmail calls).
 */
const SUBJECTS = [
  "Quick question about last week",
  "Following up on our chat",
  "Re: notes from the call",
  "Thoughts on the draft?",
  "Checking in",
];
const BODIES = [
  "Hey — just wanted to follow up on this. Let me know when you get a sec.",
  "Thanks again for the other day. Talk soon.",
  "Here's the thing I mentioned. No rush on it.",
  "Appreciate the help earlier. Have a good one.",
];
const TAG = "[wu]"; // subject tag so peers can find warmup mail to rescue

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function processWarmup() {
  const pool = await prisma.account.findMany({
    where: {
      warmupEnabled: true,
      status: "active",
      oauthRefreshEnc: { not: null },
    },
  });
  const active = pool.filter((a) => a.warmupSentTotal < a.warmupTarget);
  if (pool.length < 2) return { sent: 0, note: "need >=2 connected warmup inboxes" };

  let sent = 0;
  for (const sender of active) {
    const peers = pool.filter((p) => p.id !== sender.id);
    if (peers.length === 0) continue;

    // Gentle daily volume: ramp with progress, capped by the manual estimate.
    const remaining = sender.warmupTarget - sender.warmupSentTotal;
    const perRun = Math.max(1, Math.min(sender.warmupVolumeManual, peers.length, remaining, 5));

    for (let i = 0; i < perRun; i++) {
      const peer = pick(peers);
      const subject = `${pick(SUBJECTS)} ${TAG}`;
      const body = pick(BODIES);

      if (env.sendLive()) {
        try {
          const gmail = await gmailFor(sender.id);
          const raw = buildRawEmail({
            from: sender.email,
            to: peer.email,
            subject,
            body,
            unsubscribeUrl: "",
            messageId: generateMessageId(sender.email),
          });
          const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

          // Receiving side: rescue from spam + mark read/important (best-effort).
          try {
            const peerGmail = await gmailFor(peer.id);
            const found = await peerGmail.users.messages.list({
              userId: "me",
              q: `subject:"${TAG}" from:${sender.email} newer_than:1d`,
              maxResults: 1,
            });
            const mid = found.data.messages?.[0]?.id;
            if (mid) {
              await peerGmail.users.messages.modify({
                userId: "me",
                id: mid,
                requestBody: {
                  addLabelIds: ["IMPORTANT"],
                  removeLabelIds: ["SPAM", "UNREAD"],
                },
              });
            }
          } catch {
            /* rescue is best-effort */
          }
          if (!res.data.id) continue;
        } catch {
          continue; // sender failed — skip, try again next run
        }
      }

      await bumpSendLog(sender.id, "warmupSent");
      sent++;
    }

    const newTotal = sender.warmupSentTotal + perRun;
    await prisma.account.update({
      where: { id: sender.id },
      data: {
        warmupSentTotal: newTotal,
        // Reached target -> considered warmed; skips the cold-send ramp.
        ...(newTotal >= sender.warmupTarget ? { warmedUp: true } : {}),
      },
    });
  }

  if (sent > 0) {
    await prisma.event.create({ data: { type: "warmup_run", payload: { sent } } });
  }
  return { sent };
}
