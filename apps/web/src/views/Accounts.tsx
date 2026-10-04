import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  Card,
  Badge,
  Button,
  Check,
  Field,
  PageHeader,
  Spinner,
  EmptyState,
  Callout,
  Meter,
  healthKind,
} from "../components.js";
import { useToast } from "../toast.js";
import { useConfig } from "../config.js";
import ActivityModal from "./ActivityModal.js";
import type { Account, SendWindow } from "../types.js";

const minToHHMM = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

const DEFAULT_WINDOWS: SendWindow[] = [
  { startMin: 510, endMin: 690, weight: 0.5 },
  { startMin: 780, endMin: 990, weight: 0.35 },
  { startMin: 990, endMin: 1080, weight: 0.15 },
];

/**
 * Per-inbox pacing: how fast and when THIS inbox sends. Empty windows = use the
 * global/campaign defaults. hourlyCap / minGap are optional overrides.
 */
function PacingEditor({
  account,
  onSave,
}: {
  account: Account;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [hourlyCap, setHourlyCap] = useState<string>(
    account.hourlyCap != null ? String(account.hourlyCap) : "",
  );
  const [minGap, setMinGap] = useState<string>(
    account.minGapMinutes != null ? String(account.minGapMinutes) : "",
  );
  const [windows, setWindows] = useState<SendWindow[]>(account.sendWindowsJson ?? []);

  const setWin = (i: number, patch: Partial<SendWindow>) =>
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  const saveAll = () => {
    onSave({
      hourlyCap: hourlyCap.trim() === "" ? null : Number(hourlyCap),
      minGapMinutes: minGap.trim() === "" ? null : Number(minGap),
      sendWindows: windows.length ? windows : null,
    });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Pacing &amp; send windows</h3>
      <div className="flex flex-wrap gap-4">
        <Field label="Max sends / hour" className="w-40">
          <input
            type="number"
            min={1}
            max={60}
            value={hourlyCap}
            placeholder="No limit"
            className="input"
            onChange={(e) => setHourlyCap(e.target.value)}
          />
        </Field>
        <Field label="Min gap (minutes)" className="w-40">
          <input
            type="number"
            min={1}
            max={240}
            value={minGap}
            placeholder="Auto"
            className="input"
            onChange={(e) => setMinGap(e.target.value)}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted">
          Send windows are in each recipient's local time. Leave empty to use the defaults (08:30–11:30,
          13:00–16:30, 16:30–18:00). Weights set how sends are split between windows.
        </p>
        {windows.map((w, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="time"
              value={minToHHMM(w.startMin)}
              className="input w-32"
              onChange={(e) => setWin(i, { startMin: hhmmToMin(e.target.value) })}
            />
            <span className="text-muted">to</span>
            <input
              type="time"
              value={minToHHMM(w.endMin)}
              className="input w-32"
              onChange={(e) => setWin(i, { endMin: hhmmToMin(e.target.value) })}
            />
            <span className="ml-2 text-muted">weight</span>
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={w.weight}
              className="input w-24"
              onChange={(e) => setWin(i, { weight: Number(e.target.value) })}
            />
            <Button variant="ghost" size="sm" onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setWindows((ws) => [...ws, { startMin: 540, endMin: 660, weight: 0.3 }])}
          >
            Add window
          </Button>
          {windows.length === 0 && (
            <Button variant="secondary" size="sm" onClick={() => setWindows(DEFAULT_WINDOWS)}>
              Start from defaults
            </Button>
          )}
          <Button size="sm" onClick={saveAll}>
            Save pacing
          </Button>
        </div>
      </div>
    </div>
  );
}

function InboxSettings({
  a,
  save,
  disconnect,
  remove,
}: {
  a: Account;
  save: (patch: Record<string, unknown>) => void;
  disconnect: () => void;
  remove: () => void;
}) {
  return (
    <div className="space-y-6 border-t border-line bg-subtle/30 p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Signature (appended to every send from this inbox)" className="md:col-span-2">
          <textarea
            defaultValue={a.signature ?? ""}
            rows={3}
            className="input"
            onBlur={(e) => save({ signature: e.target.value || null })}
          />
        </Field>
        <Field
          label="Send-as alias (From address)"
          hint={`Must be a verified "Send mail as" alias on this Gmail account. Leave blank to send from ${a.email}.`}
        >
          <input
            type="email"
            defaultValue={a.sendAsEmail ?? ""}
            placeholder={a.email}
            className="input"
            onBlur={(e) => save({ sendAsEmail: e.target.value.trim() || null })}
          />
        </Field>
        <Field label="From display name">
          <input
            type="text"
            defaultValue={a.sendAsName ?? ""}
            placeholder="Optional, e.g. Alex from Acme"
            className="input"
            onBlur={(e) => save({ sendAsName: e.target.value.trim() || null })}
          />
        </Field>
      </div>

      <PacingEditor account={a} onSave={save} />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Built-in warmup</h3>
        <p className="text-xs text-muted">
          Sends friendly peer-to-peer email between your warmup-enabled inboxes (needs two or more) and rescues
          it from spam on the receiving side. When the target is reached the inbox is marked warmed.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <Check
            checked={a.warmupEnabled}
            onChange={(v) => save({ warmupEnabled: v })}
            label="Auto-warmup"
            title="Send peer-to-peer warmup mail automatically until the target is reached."
          />
          <Field label="Target (emails)" className="w-36">
            <input
              type="number"
              defaultValue={a.warmupTarget}
              className="input"
              onBlur={(e) => save({ warmupTarget: Number(e.target.value) })}
            />
          </Field>
          <div className="w-56 pb-2">
            <div className="mb-1 text-xs text-muted">
              Progress {a.warmupSentTotal}/{a.warmupTarget}
            </div>
            <Meter value={a.warmupSentTotal} max={a.warmupTarget} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button variant="danger" size="sm" onClick={disconnect}>
          Disconnect
        </Button>
        <Button variant="danger" size="sm" onClick={remove}>
          Remove inbox
        </Button>
      </div>
    </div>
  );
}

export default function Accounts() {
  const toast = useToast();
  const config = useConfig();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [activity, setActivity] = useState<Account | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () =>
    api<Account[]>("/api/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  useEffect(() => {
    load();
    // Reload when the user comes back from the OAuth popup.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const connect = async () => {
    try {
      const { url } = await api<{ url: string }>("/api/accounts/oauth/start");
      window.open(url, "_blank", "width=520,height=640");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const save = async (id: string, patch: Record<string, unknown>) => {
    try {
      await api(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast.success("Saved");
      load();
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    }
  };

  const remove = async (a: Account) => {
    if (
      !window.confirm(
        `Remove ${a.email} permanently? Queued sends are canceled, its leads get reassigned, and past messages are kept (detached). This cannot be undone.`,
      )
    )
      return;
    try {
      await api(`/api/accounts/${a.id}`, { method: "DELETE" });
      toast.info("Inbox removed");
      load();
    } catch (e) {
      toast.error(`Remove failed: ${(e as Error).message}`);
    }
  };

  const disconnect = async (a: Account) => {
    if (!window.confirm(`Disconnect ${a.email}? It will stop sending until reconnected.`)) return;
    try {
      await api(`/api/accounts/${a.id}/disconnect`, { method: "POST" });
      toast.info("Disconnected");
      load();
    } catch (e) {
      toast.error(`Disconnect failed: ${(e as Error).message}`);
    }
  };

  const totalCap = config?.perInboxTotalCap ?? 40;

  return (
    <div>
      <PageHeader
        title="Inboxes"
        description={`Sending inboxes, connected via Google OAuth. Warmup volume is reserved first, then the cold cap fills the rest of the safe total (${totalCap} per inbox per day).`}
        actions={<Button onClick={connect}>Connect Gmail</Button>}
      />

      {config && !config.googleConfigured && (
        <div className="mb-4">
          <Callout tone="warn">
            Google OAuth isn't configured. Set <code className="kbd">GOOGLE_CLIENT_ID</code> and{" "}
            <code className="kbd">GOOGLE_CLIENT_SECRET</code> in your <code className="kbd">.env</code> to connect
            inboxes. The README walks through creating them.
          </Callout>
        </div>
      )}

      {!accounts ? (
        <Spinner />
      ) : accounts.length === 0 ? (
        <Card>
          <EmptyState title="No inboxes yet" action={<Button onClick={connect}>Connect Gmail</Button>}>
            Connect each inbox you want to send from. A popup asks Google for permission to send and read
            replies; tokens are encrypted at rest.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          {accounts.map((a) => (
            <section key={a.id} className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
              <div className="flex flex-col gap-4 p-5 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" title={a.email}>
                    {a.email || "(pending)"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge kind={a.connected ? "green" : "gray"}>{a.connected ? "connected" : "not connected"}</Badge>
                    <Badge kind={healthKind(a.healthScore)}>health {a.healthScore}</Badge>
                    <Badge kind={a.status === "active" ? "green" : "yellow"}>{a.status}</Badge>
                    {a.warmedUp && <Badge kind="blue">warmed</Badge>}
                    {a.pausedUntil && new Date(a.pausedUntil) > new Date() && (
                      <Badge kind="yellow">paused until {new Date(a.pausedUntil).toLocaleString()}</Badge>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                  <Field label="Warmup / day" className="w-28">
                    <input
                      type="number"
                      defaultValue={a.warmupVolumeManual}
                      className="input"
                      onBlur={(e) => save(a.id, { warmupVolumeManual: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Cold cap / day" className="w-28">
                    <input
                      type="number"
                      defaultValue={a.dailyCapCold}
                      className="input"
                      onBlur={(e) => save(a.id, { dailyCapCold: Number(e.target.value) })}
                    />
                  </Field>
                  <div className="pb-2">
                    <Check
                      checked={a.warmedUp}
                      onChange={(v) => save(a.id, { warmedUp: v })}
                      label="Already warmed"
                      title="Skip the new-inbox ramp-up (use if the inbox was already warmed elsewhere)."
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setActivity(a)}>
                    Activity
                  </Button>
                  {a.status === "active" ? (
                    <Button variant="secondary" size="sm" onClick={() => save(a.id, { status: "paused" })}>
                      Pause
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => save(a.id, { status: "active" })}>
                      Resume
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                  >
                    {expanded === a.id ? "Hide settings" : "Settings"}
                  </Button>
                </div>
              </div>

              {expanded === a.id && (
                <InboxSettings
                  a={a}
                  save={(patch) => save(a.id, patch)}
                  disconnect={() => disconnect(a)}
                  remove={() => remove(a)}
                />
              )}
            </section>
          ))}
        </div>
      )}
      {activity && <ActivityModal account={activity} onClose={() => setActivity(null)} />}
    </div>
  );
}
