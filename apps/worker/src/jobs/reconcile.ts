import { prisma } from "@trickle/db";
import { sendQueue } from "@trickle/shared";

/**
 * reconcile: recover messages that are marked `queued` in Postgres but have no
 * live BullMQ job backing them. This happens when Redis loses its queue (e.g. a
 * container restart before AOF flush). Such messages would otherwise stay
 * `queued` forever and the planner excludes them, permanently stranding those
 * leads. We reset them to `planned` so the next daily-planner run re-slots them.
 *
 * Runs hourly. Cheap: only scans messages already in the `queued` state.
 */
export async function processReconcile() {
  const stuck = await prisma.message.findMany({
    where: { status: "queued", direction: "out" },
    select: { id: true, bulljobId: true },
  });

  let requeued = 0;
  for (const m of stuck) {
    // Is there still a live job for this message?
    const job = m.bulljobId ? await sendQueue.getJob(m.bulljobId) : null;
    if (job) {
      const state = await job.getState();
      // delayed/waiting/active/paused means it will still run — leave it alone.
      if (["delayed", "waiting", "active", "paused"].includes(state)) continue;
    }
    // No live job (lost, completed-with-stale-status, or failed-out) -> re-plan.
    await prisma.message.update({
      where: { id: m.id },
      data: { status: "planned", bulljobId: null },
    });
    requeued++;
  }

  if (requeued > 0) {
    await prisma.event.create({
      data: { type: "reconcile_run", payload: { requeued } },
    });
  }
  return { scanned: stuck.length, requeued };
}
