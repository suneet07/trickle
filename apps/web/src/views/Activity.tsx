import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Card, PageHeader, Spinner, EmptyState, fmtDateTime } from "../components.js";
import { useToast } from "../toast.js";
import type { ActivityItem } from "../types.js";

/** Events the worker records (planner runs, breakers, alerts) and audited user actions. */
export default function Activity() {
  const toast = useToast();
  const [items, setItems] = useState<ActivityItem[] | null>(null);

  useEffect(() => {
    api<ActivityItem[]>("/api/events?take=200")
      .then(setItems)
      .catch((e) => toast.error((e as Error).message));
  }, []);

  return (
    <div>
      <PageHeader
        title="Activity log"
        description="System events (planner runs, warmup, circuit breakers, alerts) and every state-changing action, newest first."
      />
      <Card flush>
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <div className="divide-y divide-line">
            {items.map((it) => {
              const detail = Object.entries(it.detail ?? {}).filter(([, v]) => v != null && v !== "");
              return (
                <div key={it.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start">
                  <div className="flex shrink-0 items-center gap-2 sm:w-64">
                    <Badge kind={it.type === "alert" ? "red" : it.kind === "audit" ? "blue" : "gray"}>
                      {it.kind === "audit" ? "action" : "event"}
                    </Badge>
                    <span className="truncate text-sm font-medium">{it.type}</span>
                  </div>
                  <div className="min-w-0 flex-1 font-mono text-xs text-muted">
                    {detail.map(([k, v]) => (
                      <span key={k} className="mr-3 inline-block break-all">
                        {k}=<span className="text-fg">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                      </span>
                    ))}
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted">{fmtDateTime(it.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
