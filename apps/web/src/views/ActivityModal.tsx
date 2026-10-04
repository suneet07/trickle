import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Modal, Spinner, EmptyState, fmtDateTime, type Tone } from "../components.js";

const MSG_KIND: Record<string, Tone> = {
  sent: "green",
  queued: "blue",
  planned: "gray",
  bounced: "red",
  failed: "red",
  canceled: "yellow",
};

interface AccountMessages {
  total: number;
  sentCount: number;
  messages: {
    id: string;
    status: string;
    subject: string;
    stepIndex: number;
    sentAt: string | null;
    scheduledAt: string | null;
    lead: { email: string; name: string | null } | null;
    campaign: { name: string } | null;
  }[];
}

/** Everything one inbox has sent or has scheduled, newest first. */
export default function ActivityModal({
  account,
  onClose,
}: {
  account: { id: string; email: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<AccountMessages | null>(null);
  useEffect(() => {
    api<AccountMessages>(`/api/accounts/${account.id}/messages?take=200`).then(setData).catch(() => {});
  }, [account.id]);

  return (
    <Modal title={`${account.email} · sent activity`} onClose={onClose} wide>
      {!data ? (
        <Spinner />
      ) : data.messages.length === 0 ? (
        <EmptyState title="Nothing sent from this inbox yet" />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            {data.sentCount} sent · {data.total} total outbound
          </p>
          <div className="-mx-5 overflow-x-auto border-t border-line">
            <table className="table">
              <thead>
                <tr>
                  <th>To</th>
                  <th>Subject</th>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Sent / scheduled</th>
                </tr>
              </thead>
              <tbody>
                {data.messages.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap">{m.lead?.email}</td>
                    <td className="max-w-[220px] truncate text-muted">{m.subject}</td>
                    <td className="whitespace-nowrap text-muted">
                      {m.campaign?.name ?? (m.stepIndex > 0 ? "follow-up" : "one-off")}
                    </td>
                    <td>
                      <Badge kind={MSG_KIND[m.status] ?? "gray"}>{m.status}</Badge>
                    </td>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(m.sentAt ?? m.scheduledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
