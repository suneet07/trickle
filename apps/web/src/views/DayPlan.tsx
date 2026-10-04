import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, PageHeader, Spinner, EmptyState, Meter } from "../components.js";
import type { SchedulePlan } from "../types.js";

/**
 * Day plan: for a chosen date, every inbox with how many sends it will make,
 * when (UTC-hour histogram), and its cap / used / remaining — the "how many,
 * from which inbox, when" overview.
 */
export default function DayPlan() {
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api<SchedulePlan>(`/api/dashboard/schedule?date=${date}`)
      .then(setPlan)
      .catch(() => setPlan(null))
      .finally(() => setLoading(false));
  }, [date]);

  // Only `queued` rows actually send that day; `backlog` rows wait on cap.
  const totalQueued = plan?.inboxes.reduce((s, i) => s + i.queuedCount, 0) ?? 0;
  const totalBacklog = plan?.inboxes.reduce((s, i) => s + i.backlogCount, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="Day plan"
        description={
          plan
            ? `${totalQueued} queued to send${totalBacklog ? ` · ${totalBacklog} in backlog, waiting for cap to free up` : ""}. Hours are UTC.`
            : "How many emails each inbox sends on a given day, and when."
        }
        actions={<input type="date" value={date} className="input w-auto" onChange={(e) => setDate(e.target.value)} />}
      />
      {loading || !plan ? (
        <Spinner />
      ) : plan.inboxes.length === 0 ? (
        <Card>
          <EmptyState title="No inboxes connected" />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {plan.inboxes.map((ib) => {
            const maxHour = Math.max(1, ...Object.values(ib.hourly));
            return (
              <Card
                key={ib.id}
                title={ib.email}
                actions={<Badge kind={ib.status === "active" ? "green" : "yellow"}>{ib.status}</Badge>}
              >
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  <span>
                    <span className="font-semibold tabular-nums">{ib.queuedCount}</span>{" "}
                    <span className="text-muted">queued</span>
                  </span>
                  {ib.backlogCount > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums">{ib.backlogCount}</span>{" "}
                      <span className="text-muted">backlog</span>
                    </span>
                  )}
                  <span className="text-ok">{ib.remainingToday} left</span>
                  <span className="text-muted">
                    cap {ib.effectiveCap} · used {ib.usedToday}
                  </span>
                </div>
                <div className="mt-2">
                  <Meter value={ib.usedToday} max={ib.effectiveCap} />
                </div>

                <div className="mt-5 flex h-20 items-end gap-[3px]">
                  {Array.from({ length: 24 }, (_, h) => {
                    const c = ib.hourly[String(h)] ?? 0;
                    return (
                      <div key={h} className="flex h-full flex-1 flex-col items-center justify-end" title={`${h}:00 UTC: ${c}`}>
                        <div
                          className="w-full rounded-sm bg-accent/80"
                          style={{ height: `${(c / maxHour) * 100}%`, minHeight: c ? 3 : 1, opacity: c ? 1 : 0.15 }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted">
                  <span>00</span>
                  <span>06</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>

                {ib.slots.length > 0 && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium text-accent">
                      Show {ib.slots.length} sends
                    </summary>
                    <div className="mt-2 max-h-64 divide-y divide-line overflow-y-auto text-sm">
                      {ib.slots.map((s) => (
                        <div key={s.id} className="flex flex-wrap items-center gap-3 py-1.5">
                          <span className="w-28 whitespace-nowrap tabular-nums text-muted">
                            {s.scheduledAt
                              ? new Date(s.scheduledAt).toLocaleString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  month: "short",
                                  day: "numeric",
                                })
                              : "—"}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{s.lead.email}</span>
                          <span className="text-xs text-muted">{s.campaign?.name ?? "one-off"}</span>
                          <Badge kind={s.status === "queued" ? "blue" : "gray"}>{s.status}</Badge>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
