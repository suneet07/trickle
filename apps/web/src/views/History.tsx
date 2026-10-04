import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, PageHeader, Spinner, Stat } from "../components.js";
import { useToast } from "../toast.js";
import type { HistoryPoint } from "../types.js";

export default function History() {
  const toast = useToast();
  const [data, setData] = useState<HistoryPoint[] | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setData(null);
    api<HistoryPoint[]>(`/api/dashboard/history?days=${days}`)
      .then(setData)
      .catch((e) => toast.error((e as Error).message));
  }, [days]);

  const max = data ? Math.max(1, ...data.map((d) => d.sent)) : 1;
  const totals = data
    ? data.reduce(
        (acc, d) => ({ sent: acc.sent + d.sent, replies: acc.replies + d.replies, bounces: acc.bounces + d.bounces }),
        { sent: 0, replies: 0, bounces: 0 },
      )
    : null;
  const pct = (n: number) => (totals && totals.sent ? `${((n / totals.sent) * 100).toFixed(1)}%` : "—");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sending history"
        description="Daily totals across all inboxes, including warmup traffic."
        actions={
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input w-auto">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />
      {!data || !totals ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Sent" value={totals.sent} />
            <Stat label="Replies" value={totals.replies} hint={`${pct(totals.replies)} of sent`} tone="ok" />
            <Stat
              label="Bounces"
              value={totals.bounces}
              hint={`${pct(totals.bounces)} of sent`}
              tone={totals.sent && totals.bounces / totals.sent > 0.03 ? "bad" : undefined}
            />
          </div>
          <Card title="Emails sent per day">
            <div className="flex h-48 items-end gap-[3px]">
              {data.map((d) => (
                <div
                  key={d.date}
                  className="flex h-full flex-1 flex-col justify-end"
                  title={`${d.date}: ${d.sent} sent, ${d.replies} replies, ${d.bounces} bounces`}
                >
                  <div
                    className="rounded-t-sm bg-accent/80"
                    style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 2 : 1, opacity: d.sent ? 1 : 0.15 }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>{data[0]?.date}</span>
              <span>{data[data.length - 1]?.date}</span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
