import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  Card,
  Button,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  EmptyState,
  Badge,
  cx,
  fmtDateTime,
} from "../components.js";
import { useToast } from "../toast.js";
import { navigate } from "../router.js";
import { STATUS_KIND } from "./Leads.js";
import type { Lead, Message } from "../types.js";

type Thread = Lead & { messages: Message[]; account?: { id?: string; email: string } | null };

/** Gmail snippets come HTML-entity-encoded (&lt; &gt; &amp; &#39;) — decode for display. */
function decodeEntities(s: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

/**
 * The label for one message row. Reads `status` first so an unsent follow-up
 * (still `planned`, scheduled days out) never looks like a real send;
 * `direction` only decides in vs out.
 */
function messageLabel(m: Message): { text: string; tone: "in" | "sent" | "pending" | "bad" } {
  if (m.direction === "in") return { text: `Reply · ${fmtDateTime(m.sentAt ?? m.createdAt)}`, tone: "in" };
  switch (m.status) {
    case "sent":
      return { text: `${m.isManualReply ? "You replied" : "Sent"} · ${fmtDateTime(m.sentAt)}`, tone: "sent" };
    case "planned":
      return { text: `Not sent yet · scheduled ${fmtDateTime(m.scheduledAt)}`, tone: "pending" };
    case "queued":
      return { text: `Queued · ${fmtDateTime(m.scheduledAt)}`, tone: "pending" };
    case "bounced":
      return { text: `Bounced · ${fmtDateTime(m.sentAt)}`, tone: "bad" };
    case "failed":
      return { text: `Failed${m.error ? ` · ${m.error.slice(0, 60)}` : ""}`, tone: "bad" };
    case "canceled":
      return { text: "Canceled", tone: "bad" };
    default:
      return { text: m.status, tone: "pending" };
  }
}

/**
 * Order by when the message actually lands. The whole follow-up ladder can be
 * created at once, so createdAt would clump every step together.
 */
function sortMessages(msgs: Message[]): Message[] {
  const when = (m: Message) => new Date(m.sentAt ?? m.scheduledAt ?? m.createdAt).getTime();
  return [...msgs].sort((a, b) => when(a) - when(b));
}

const ROW_TONE: Record<string, string> = {
  in: "border-l-2 border-ok bg-ok/5",
  sent: "border-l-2 border-line",
  pending: "border-l-2 border-dashed border-line opacity-70",
  bad: "border-l-2 border-bad bg-bad/5",
};

const LABEL_TONE: Record<string, string> = {
  in: "text-ok",
  sent: "text-muted",
  pending: "text-warn",
  bad: "text-bad",
};

const STATUS_TABS = [
  { key: "", label: "Active" },
  { key: "replied", label: "Replied" },
  { key: "contacted", label: "Contacted" },
  { key: "followup", label: "In follow-up" },
];

export default function Inbox() {
  const toast = useToast();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("replied");
  const [search, setSearch] = useState("");
  const [skip, setSkip] = useState(0);
  const [replyTo, setReplyTo] = useState<Thread | null>(null);
  const TAKE = 50;

  const load = () => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (search) p.set("search", search);
    p.set("take", String(TAKE));
    p.set("skip", String(skip));
    api<{ total: number; leads: Thread[] }>(`/api/threads?${p.toString()}`)
      .then((r) => {
        setThreads(r.leads);
        setTotal(r.total);
      })
      .catch((e) => toast.error((e as Error).message));
  };
  useEffect(load, [status, skip]);
  useEffect(() => {
    const t = setTimeout(() => (skip === 0 ? load() : setSkip(0)), 300);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div>
      <PageHeader
        title="Replies"
        description="Conversations with your leads across every inbox. Replies are picked up every 10 minutes; auto-replies and out-of-office messages are ignored."
      />
      <Card flush>
        <div className="flex flex-col gap-3 border-b border-line px-5 py-3 md:flex-row md:items-center">
          <div className="flex flex-wrap gap-1">
            {STATUS_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setSkip(0);
                  setStatus(t.key);
                }}
                className={cx(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  status === t.key ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-subtle hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input md:ml-auto md:w-72"
          />
        </div>

        {!threads ? (
          <Spinner />
        ) : threads.length === 0 ? (
          <EmptyState title="Nothing here">
            {status === "replied" ? "No replies yet. They show up here as soon as they're detected." : undefined}
          </EmptyState>
        ) : (
          <div className="divide-y divide-line">
            {threads.map((t) => (
              <div key={t.id} className="px-5 py-5">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button className="text-left text-sm font-semibold hover:underline" onClick={() => navigate(`/leads/${t.id}`)}>
                      {t.name ?? t.email}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{t.email}</span>
                      {t.company && <span>· {t.company}</span>}
                      <Badge kind={STATUS_KIND[t.status] ?? "gray"}>{t.status}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.account?.email && <span className="text-xs text-muted">via {t.account.email}</span>}
                    <Button variant="secondary" size="sm" onClick={() => setReplyTo(t)}>
                      Reply
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {sortMessages(t.messages).map((m) => {
                    const lbl = messageLabel(m);
                    return (
                      <div key={m.id} className={cx("rounded-r-md py-1.5 pl-3 pr-2", ROW_TONE[lbl.tone])}>
                        <div className={cx("text-xs font-medium", LABEL_TONE[lbl.tone])}>
                          {lbl.text}
                          {m.direction === "out" && m.stepIndex > 0 ? ` · step ${m.stepIndex + 1}` : ""}
                          <span className="font-normal text-muted"> · {decodeEntities(m.subject)}</span>
                        </div>
                        <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm">
                          {decodeEntities(m.body ?? "").slice(0, 400)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="px-5 pb-4">
          <Pagination total={total} take={TAKE} skip={skip} onPage={setSkip} />
        </div>
      </Card>

      {replyTo && (
        <ReplyModal
          thread={replyTo}
          onClose={() => setReplyTo(null)}
          onSent={() => {
            setReplyTo(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ReplyModal({ thread, onClose, onSent }: { thread: Thread; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const lastSubject = [...thread.messages].reverse().find((m) => m.subject)?.subject ?? "";
  const [subject, setSubject] = useState(/^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!subject.trim() || !body.trim()) return;
    setSending(true);
    try {
      await api(`/api/threads/${thread.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      });
      toast.success("Reply queued");
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      title={`Reply to ${thread.name ?? thread.email}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || !body.trim()}>
            {sending ? "Sending…" : "Send reply"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="To">
          <input className="input" value={thread.email} disabled />
        </Field>
        <Field label="Subject">
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" hint="Sent in the existing thread. Dry-run mode applies.">
          <textarea className="input" rows={8} placeholder="Your reply…" value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}
