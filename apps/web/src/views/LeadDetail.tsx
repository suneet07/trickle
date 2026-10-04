import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Button, Card, Callout, PageHeader, Spinner, fmtDateTime } from "../components.js";
import { useToast } from "../toast.js";
import { navigate } from "../router.js";
import { STATUS_KIND, ComposeModal } from "./Leads.js";
import type { Account, LeadDetailResponse, LeadStatus, Message } from "../types.js";

export default function LeadDetail({ id }: { id: string }) {
  const toast = useToast();
  const [data, setData] = useState<LeadDetailResponse | null>(null);
  const [notes, setNotes] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [composing, setComposing] = useState(false);

  const load = () =>
    api<LeadDetailResponse>(`/api/leads/${id}`)
      .then((d) => {
        setData(d);
        setNotes(d.lead.notes ?? "");
      })
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    load();
    api<Account[]>("/api/accounts")
      .then((a) => setAccounts(a.filter((x) => x.connected)))
      .catch(() => {});
  }, [id]);

  if (!data) return <Spinner />;
  const { lead, suppressed, nextStep } = data;

  const setStatus = async (status: LeadStatus) => {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    toast.success(`Status set to ${status}`);
    load();
  };
  const saveNotes = async () => {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ notes }) });
    toast.success("Notes saved");
  };
  const snooze = async (days: number | null) => {
    const until = days == null ? null : new Date(Date.now() + days * 86400000).toISOString();
    await api(`/api/leads/${id}/snooze`, { method: "POST", body: JSON.stringify({ until }) });
    toast.success(days == null ? "Un-snoozed" : `Snoozed ${days} days`);
    load();
  };
  const skipFollowup = async () => {
    const r = await api<{ skipped: number }>(`/api/leads/${id}/skip-followup`, { method: "POST" });
    toast.info(r.skipped ? "Next follow-up skipped" : "No pending follow-up to skip");
    load();
  };

  const custom = Object.entries(lead.customFields ?? {});

  return (
    <div className="space-y-6">
      <button onClick={() => navigate("/leads")} className="text-sm text-muted hover:text-fg">
        ← Back to leads
      </button>
      <PageHeader
        title={lead.name ?? lead.email}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {lead.email} <Badge kind={STATUS_KIND[lead.status] ?? "gray"}>{lead.status}</Badge>
          </span>
        }
        actions={<Button onClick={() => setComposing(true)}>Email this lead</Button>}
      />

      {suppressed && <Callout tone="bad">This address is on the suppression list. Nothing will be sent to it.</Callout>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Sequence">
            <p className="mb-4 text-sm text-muted">
              {nextStep
                ? `Next: ${nextStep.stepIndex === 0 ? "initial email" : `follow-up ${nextStep.stepIndex}`} (${nextStep.status}), ${fmtDateTime(nextStep.scheduledAt)}`
                : "No pending sends."}
            </p>
            {lead.messages.length === 0 ? (
              <p className="text-sm text-muted">Nothing sent yet.</p>
            ) : (
              <div className="space-y-3">
                {lead.messages.map((m) => (
                  <MessageRow key={m.id} m={m} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Notes">
            <textarea className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="mt-3 text-right">
              <Button variant="secondary" onClick={saveNotes}>
                Save notes
              </Button>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="space-y-2.5 text-sm">
              <Row label="Company" value={lead.company} />
              <Row label="Title" value={lead.title} />
              <Row label="Location" value={[lead.city, lead.state, lead.zip].filter(Boolean).join(", ")} />
              <Row label="Timezone" value={lead.timezone} />
              <Row label="Region" value={lead.region?.name} />
              <Row label="Sending inbox" value={lead.account?.email} />
              <Row label="Snoozed until" value={lead.snoozeUntil ? fmtDateTime(lead.snoozeUntil) : null} />
              {custom.map(([k, v]) => (
                <Row key={k} label={k} value={String(v)} />
              ))}
            </dl>
          </Card>

          <Card title="Controls">
            <div className="space-y-4">
              <div>
                <div className="label">Set status</div>
                <div className="flex flex-wrap gap-1.5">
                  {(["pending", "contacted", "replied", "do_not_contact"] as LeadStatus[]).map((s) => (
                    <Button key={s} variant={lead.status === s ? "primary" : "secondary"} size="sm" onClick={() => setStatus(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <div className="label">Pause this lead</div>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => snooze(3)}>
                    Snooze 3 days
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => snooze(7)}>
                    Snooze 7 days
                  </Button>
                  {lead.snoozeUntil && (
                    <Button variant="secondary" size="sm" onClick={() => snooze(null)}>
                      Un-snooze
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={skipFollowup}>
                    Skip next follow-up
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {composing && (
        <ComposeModal
          lead={lead}
          accounts={accounts}
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            toast.success("Email queued");
            load();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-right" title={value ?? undefined}>
        {value || "—"}
      </dd>
    </div>
  );
}

function MessageRow({ m }: { m: Message & { campaign?: { status: string } | null } }) {
  const label =
    m.direction === "in"
      ? "Reply"
      : m.isManualReply
        ? "Manual reply"
        : m.stepIndex === 0
          ? "Initial"
          : `Follow-up ${m.stepIndex}`;
  const pending = m.status === "planned" || m.status === "queued";
  return (
    <div
      className={
        m.direction === "in"
          ? "rounded-lg border border-ok/30 bg-ok/5 p-4"
          : pending
            ? "rounded-lg border border-dashed border-line p-4 opacity-80"
            : "rounded-lg border border-line p-4"
      }
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge kind={m.direction === "in" ? "green" : "gray"}>{label}</Badge>
          <span className="text-xs text-muted">{m.status}</span>
          {pending && m.campaign && m.campaign.status !== "running" && <Badge kind="yellow">campaign paused</Badge>}
          {m.variant === "B" && <Badge kind="blue">variant B</Badge>}
          {m.openedAt && <Badge kind="green">opened</Badge>}
          {m.clickedAt && <Badge kind="green">clicked</Badge>}
        </div>
        <span className="text-xs text-muted">{fmtDateTime(m.sentAt ?? m.scheduledAt)}</span>
      </div>
      <div className="text-sm font-medium">{m.subject}</div>
      <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-muted">{m.body}</div>
      {m.error && <div className="mt-2 text-xs text-bad">{m.error}</div>}
    </div>
  );
}
