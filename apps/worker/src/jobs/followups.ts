import { DateTime } from "luxon";
import { prisma, Prisma } from "@trickle/db";
import { renderTemplate, leadMergeVars } from "@trickle/core";

interface FollowUpStep {
  dayOffset: number;
  subjectTemplate: string;
  bodyTemplate: string;
}

/**
 * After an initial (or prior) send, create the next follow-up Message rows in
 * status=planned with a target scheduledAt = sentAt + dayOffset. The daily
 * planner slots them into proper send windows when due. Sent in the same Gmail
 * thread; auto-canceled on reply/bounce/unsub.
 */
export async function scheduleFollowUps(initialMessageId: string) {
  const initial = await prisma.message.findUniqueOrThrow({
    where: { id: initialMessageId },
    include: { campaign: true, lead: true },
  });
  if (!initial.campaign) return;

  const steps = (initial.campaign.followUpsJson ?? []) as unknown as FollowUpStep[];
  if (!Array.isArray(steps) || steps.length === 0) return;

  const vars = leadMergeVars(initial.lead);
  const base = initial.sentAt ?? new Date();

  const data: Prisma.MessageCreateManyInput[] = steps.map((step, i) => ({
    direction: "out",
    status: "planned",
    variant: initial.variant,
    stepIndex: i + 1,
    subject: renderTemplate(step.subjectTemplate, vars),
    body: renderTemplate(step.bodyTemplate, vars),
    // Target date; planner reschedules to a real slot on/after this day.
    scheduledAt: DateTime.fromJSDate(base).plus({ days: step.dayOffset }).toJSDate(),
    leadId: initial.leadId,
    campaignId: initial.campaignId,
    accountId: initial.accountId,
    gmailThreadId: initial.gmailThreadId,
  }));

  await prisma.message.createMany({ data });
}

/** Cancel all pending follow-ups for a lead (reply/bounce/unsub). */
export async function cancelFollowUps(leadId: string) {
  await prisma.message.updateMany({
    where: {
      leadId,
      direction: "out",
      stepIndex: { gt: 0 },
      status: { in: ["planned", "queued"] },
    },
    data: { status: "canceled" },
  });
}
