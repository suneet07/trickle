import { Fragment, useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, Button, Field, Modal, PageHeader, Spinner, EmptyState } from "../components.js";
import { useToast } from "../toast.js";
import type { Account } from "../types.js";

/**
 * Send queue: every planned/queued email — who it goes to, from which inbox,
 * which campaign/step, and exactly when (shown in your local time, with the
 * lead's own timezone alongside). Each row is editable: reschedule the time,
 * move it to a different inbox, or hold it.
 */
interface QueueItem {
  id: string;
  status: string;
  stepIndex: number;
  subject: string;
  scheduledAt: string | null;
  lead: { name: string | null; email: string; timezone: string };
  account: { email: string } | null;
  campaign: { name: string } | null;
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time.
function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The scheduled instant as the recipient sees it. */
function leadLocal(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function Queue() {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState(7);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editing, setEditing] = useState<QueueItem | null>(null);

  const load = () => {
    api<{ total: number; items: QueueItem[] }>(`/api/dashboard/queue?days=${days}`)
      .then((d) => {
        setItems(d.items);
        setTotal(d.total);
      })
      .catch(() => setItems([]));
  };
  useEffect(load, [days]);
  useEffect(() => {
    api<Account[]>("/api/accounts").then(setAccounts).catch(() => {});
  }, []);

  const hold = async (m: QueueItem) => {
    try {
      await api(`/api/queue/${m.id}/hold`, { method: "POST" });
      toast.info("Held. It won't send until you release it.");
      load();
    } catch (e) {
      toast.error(`Hold failed: ${(e as Error).message}`);
    }
  };

  const dayKey = (iso: string | null) => (iso ? new Date(iso).toDateString() : "unscheduled");
  let lastDay = "";

  return (
    <div>
      <PageHeader
        title="Send queue"
        description={`${total} email${total === 1 ? "" : "s"} scheduled. Times are in your local timezone; the recipient's local time is shown alongside.`}
        actions={
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Next 24 hours</option>
            <option value={3}>Next 3 days</option>
            <option value={7}>Next 7 days</option>
            <option value={30}>Next 30 days</option>
          </select>
        }
      />
      <Card flush>
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing queued">
            The daily planner (00:05 UTC, and right after a launch) slots sends for running campaigns.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>To</th>
                  <th>From inbox</th>
                  <th>Campaign</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => {
                  const isNewDay = dayKey(m.scheduledAt) !== lastDay;
                  lastDay = dayKey(m.scheduledAt);
                  return (
                    <Fragment key={m.id}>
                      {isNewDay && (
                        <tr>
                          <td colSpan={7} className="bg-subtle/60 !py-1.5 text-xs font-semibold text-muted">
                            {m.scheduledAt
                              ? new Date(m.scheduledAt).toLocaleDateString(undefined, {
                                  weekday: "long",
                                  month: "long",
                                  day: "numeric",
                                })
                              : "Unscheduled"}
                          </td>
                        </tr>
                      )}
                      <tr>
                        <td className="whitespace-nowrap">
                          <div className="font-medium tabular-nums">
                            {m.scheduledAt
                              ? new Date(m.scheduledAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                              : "—"}
                          </div>
                          <div className="text-xs text-muted">
                            {leadLocal(m.scheduledAt, m.lead.timezone)} {m.lead.timezone}
                          </div>
                        </td>
                        <td>
                          <div>{m.lead.name ?? m.lead.email}</div>
                          {m.lead.name && <div className="text-xs text-muted">{m.lead.email}</div>}
                        </td>
                        <td className="whitespace-nowrap text-muted">{m.account?.email ?? "—"}</td>
                        <td className="text-muted">{m.campaign?.name ?? "one-off"}</td>
                        <td className="whitespace-nowrap">{m.stepIndex === 0 ? "initial" : `follow-up ${m.stepIndex}`}</td>
                        <td>
                          <Badge kind={m.status === "queued" ? "blue" : "gray"}>{m.status}</Badge>
                        </td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => hold(m)}
                              title="Cancel this send's job and park it until you release it"
                            >
                              Hold
                            </Button>
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <EditModal
          item={editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function EditModal({
  item,
  accounts,
  onClose,
  onSaved,
}: {
  item: QueueItem;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [when, setWhen] = useState(toLocalInput(item.scheduledAt));
  const [accountEmail, setAccountEmail] = useState(item.account?.email ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      // Only send scheduledAt if it changed from the original.
      const newIso = new Date(when).toISOString();
      if (!item.scheduledAt || newIso !== new Date(item.scheduledAt).toISOString()) patch.scheduledAt = newIso;
      const acct = accounts.find((a) => a.email === accountEmail);
      if (acct && acct.email !== item.account?.email) patch.accountId = acct.id;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      await api(`/api/queue/${item.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast.success("Updated");
      onSaved();
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Edit scheduled send"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          To <span className="font-medium text-fg">{item.lead.email}</span>
          {item.campaign ? ` · ${item.campaign.name}` : " · one-off"}
        </p>
        <Field label="Send at (your local time)">
          <input type="datetime-local" value={when} className="input" onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="From inbox">
          <select value={accountEmail} className="input" onChange={(e) => setAccountEmail(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.email}>
                {a.email}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
