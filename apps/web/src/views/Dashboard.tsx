import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, Button, PageHeader, Stat, Meter, EmptyState, healthKind, cx } from "../components.js";
import { useConfig } from "../config.js";
import { navigate } from "../router.js";
import ActivityModal from "./ActivityModal.js";

interface DashAccount {
  id: string;
  email: string;
  status: string;
  healthScore: number;
  warmupVolume: number;
  capCold: number;
  capBreakdown?: {
    base: number;
    warmupVolume: number;
    headroomAfterWarmup: number;
    healthMultiplier: number;
    rampFactor: number;
    effectiveCap: number;
    usedToday: number;
    remainingToday: number;
  };
  queuedToday: number;
  sentToday: number;
  bouncesToday: number;
  repliesToday: number;
}

interface DashCampaign {
  id: string;
  name: string;
  status: string;
  sent: number;
  replies: number;
  bounces: number;
  replyRate: number;
}

const STATUS_KIND = (s: string) =>
  s === "running" ? "green" : s === "paused" ? "yellow" : s === "scheduled" ? "blue" : "gray";

export default function Dashboard() {
  const config = useConfig();
  const [accounts, setAccounts] = useState<DashAccount[] | null>(null);
  const [campaigns, setCampaigns] = useState<DashCampaign[]>([]);
  const [calendar, setCalendar] = useState<{ date: string; count: number }[]>([]);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [activity, setActivity] = useState<DashAccount | null>(null);

  useEffect(() => {
    api<DashAccount[]>("/api/dashboard/accounts").then(setAccounts).catch(() => setAccounts([]));
    api<DashCampaign[]>("/api/dashboard/campaigns").then(setCampaigns).catch(() => {});
    api("/api/dashboard/calendar").then(setCalendar).catch(() => {});
    api<{ total: number }>("/api/leads?take=1").then((r) => setLeadCount(r.total)).catch(() => {});
  }, []);

  const maxCal = Math.max(1, ...calendar.map((c) => c.count));
  const sentToday = (accounts ?? []).reduce((s, a) => s + a.sentToday, 0);
  const capToday = (accounts ?? []).reduce((s, a) => s + a.capCold, 0);
  const queuedToday = (accounts ?? []).reduce((s, a) => s + a.queuedToday, 0);
  const repliesToday = (accounts ?? []).reduce((s, a) => s + a.repliesToday, 0);
  const totals = campaigns.reduce(
    (t, c) => ({ sent: t.sent + c.sent, replies: t.replies + c.replies, bounces: t.bounces + c.bounces }),
    { sent: 0, replies: 0, bounces: 0 },
  );

  const steps = [
    {
      done: !!accounts && accounts.length > 0,
      title: "Connect a Gmail inbox",
      body: "Trickle sends through your own Gmail or Google Workspace inboxes via OAuth.",
      action: () => navigate("/inboxes"),
      cta: "Go to inboxes",
    },
    {
      done: (leadCount ?? 0) > 0,
      title: "Import leads",
      body: "Upload a CSV or XLSX. Extra columns become {{merge}} variables.",
      action: () => navigate("/leads"),
      cta: "Import leads",
    },
    {
      done: campaigns.some((c) => c.status !== "draft"),
      title: "Launch a campaign",
      body: "Write your sequence, run a placement test, then launch. Sends spread across recipients' working hours.",
      action: () => navigate("/campaigns"),
      cta: "New campaign",
    },
    {
      done: !!config?.sendLive,
      title: "Go live",
      body: "You're in dry-run until SEND_LIVE=true in your .env. Nothing is emailed until then.",
      action: () => navigate("/settings"),
      cta: "View settings",
    },
  ];
  const showSetup = accounts !== null && leadCount !== null && steps.some((s) => !s.done);

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Today's sending across every inbox, and how campaigns are doing." />

      {showSetup && (
        <Card title="Get started" description="Four steps from install to your first human-paced campaign.">
          <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((s, i) => (
              <li
                key={s.title}
                className={cx(
                  "flex flex-col rounded-lg border p-4",
                  s.done ? "border-ok/30 bg-ok/5" : "border-line bg-surface",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cx(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      s.done ? "bg-ok text-white" : "bg-subtle text-muted",
                    )}
                  >
                    {s.done ? "✓" : i + 1}
                  </span>
                  <span className="text-sm font-medium">{s.title}</span>
                </div>
                <p className="mt-2 flex-1 text-sm text-muted">{s.body}</p>
                {!s.done && (
                  <div className="mt-3">
                    <Button size="sm" variant="secondary" onClick={s.action}>
                      {s.cta}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sent today" value={sentToday} hint={`of ${capToday} cold capacity`} />
        <Stat label="Still queued today" value={queuedToday} />
        <Stat label="Replies today" value={repliesToday} tone={repliesToday ? "ok" : undefined} />
        <Stat
          label="All-time reply rate"
          value={totals.sent ? `${((totals.replies / totals.sent) * 100).toFixed(1)}%` : "—"}
          hint={`${totals.replies} replies · ${totals.bounces} bounces · ${totals.sent} sent`}
        />
      </div>

      <Card title="Inboxes" description="Click an inbox to see everything it has sent.">
        {accounts && accounts.length === 0 ? (
          <EmptyState
            title="No inboxes connected yet"
            action={<Button onClick={() => navigate("/inboxes")}>Connect Gmail</Button>}
          >
            Connect at least one Gmail inbox to start sending. Two or more enable warmup and placement tests.
          </EmptyState>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {(accounts ?? []).map((a) => (
              <button
                key={a.id}
                onClick={() => setActivity(a)}
                className="rounded-lg border border-line p-4 text-left transition-colors hover:border-accent/50 hover:bg-subtle/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">{a.email}</span>
                  <div className="flex shrink-0 gap-1.5">
                    {a.status !== "active" && <Badge kind="red">{a.status}</Badge>}
                    <Badge kind={healthKind(a.healthScore)}>health {a.healthScore}</Badge>
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between text-sm">
                  <span className="tabular-nums">
                    <span className="font-semibold">{a.sentToday}</span>
                    <span className="text-muted"> / {a.capCold} sent today</span>
                  </span>
                  <span className="text-xs text-muted">
                    warmup ~{a.warmupVolume} · {a.bouncesToday} bounces · {a.repliesToday} replies
                  </span>
                </div>
                <div className="mt-2">
                  <Meter value={a.sentToday} max={a.capCold} />
                </div>
                {a.capBreakdown && (
                  <div className="mt-2 font-mono text-[11px] text-muted" title="How the daily cold cap was derived">
                    cap {a.capBreakdown.base} → {a.capBreakdown.headroomAfterWarmup} (warmup −
                    {a.capBreakdown.warmupVolume}) × {a.capBreakdown.healthMultiplier} health ×{" "}
                    {a.capBreakdown.rampFactor} age = {a.capBreakdown.effectiveCap}/day ·{" "}
                    <span className="text-ok">{a.capBreakdown.remainingToday} left</span>
                    {a.queuedToday ? ` (${a.queuedToday} queued)` : ""}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Next 7 days" description="Planned sends per day (UTC)." className="xl:col-span-2">
          <div className="flex h-40 items-end gap-2">
            {calendar.map((c) => (
              <div key={c.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <div className="text-xs tabular-nums text-muted">{c.count || ""}</div>
                <div
                  className="w-full rounded-t-md bg-accent/80"
                  style={{ height: `${(c.count / maxCal) * 100}%`, minHeight: c.count ? 4 : 2, opacity: c.count ? 1 : 0.2 }}
                />
                <div className="text-[11px] text-muted">
                  {new Date(c.date + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Campaigns" flush className="xl:col-span-3">
          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" action={<Button onClick={() => navigate("/campaigns")}>New campaign</Button>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th className="text-right">Sent</th>
                    <th className="text-right">Replies</th>
                    <th className="text-right">Reply rate</th>
                    <th className="text-right">Bounces</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className="font-medium">{c.name}</td>
                      <td>
                        <Badge kind={STATUS_KIND(c.status)}>{c.status}</Badge>
                      </td>
                      <td className="text-right tabular-nums">{c.sent}</td>
                      <td className="text-right tabular-nums">{c.replies}</td>
                      <td className="text-right tabular-nums">{(c.replyRate * 100).toFixed(1)}%</td>
                      <td className="text-right tabular-nums">{c.bounces}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {activity && <ActivityModal account={activity} onClose={() => setActivity(null)} />}
    </div>
  );
}
