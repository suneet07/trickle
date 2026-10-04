import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  Card,
  Badge,
  Button,
  Modal,
  PageHeader,
  Field,
  Check,
  Callout,
  EmptyState,
  Spinner,
  cx,
  type Tone,
} from "../components.js";
import { useToast } from "../toast.js";
import type { Campaign, AbReport, FollowUpStep } from "../types.js";

type FooterMode = "default" | "custom" | "none";

/** The editor's working copy: a campaign plus the filter fields it edits. */
interface Draft {
  id?: string;
  status?: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  subjectVariantB?: string | null;
  bodyVariantB?: string | null;
  abEnabled?: boolean;
  followUps: FollowUpStep[];
  cities: string[];
  timezones: string[];
  isHtml?: boolean;
  trackOpens?: boolean;
  trackClicks?: boolean;
  unsubHeader?: boolean;
  footerOverride?: string | null;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  subjectTemplate: "",
  bodyTemplate: "",
  cities: [],
  timezones: [],
  followUps: [],
};

const STATUS_KIND = (s: string): Tone =>
  s === "running" ? "green" : s === "paused" ? "yellow" : s === "scheduled" ? "blue" : "gray";

// Read stored filters back into editor shape, tolerating the legacy single
// `city` key so older campaigns still open with their filter intact.
function toDraft(c: Campaign): Draft {
  const f = (c.filtersJson ?? {}) as Record<string, unknown>;
  return {
    ...c,
    cities: Array.isArray(f.cities) ? (f.cities as string[]) : typeof f.city === "string" ? [f.city] : [],
    timezones: Array.isArray(f.timezones) ? (f.timezones as string[]) : [],
    followUps: c.followUpsJson ?? [],
  };
}

export default function Campaigns() {
  const toast = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [cities, setCities] = useState<{ city: string; count: number }[]>([]);
  const [timezones, setTimezones] = useState<{ timezone: string; count: number }[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [abFor, setAbFor] = useState<Campaign | null>(null);

  const load = () =>
    api<Campaign[]>(`/api/campaigns?includeArchived=${showArchived}`)
      .then(setCampaigns)
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    load();
  }, [showArchived]);
  useEffect(() => {
    api("/api/leads/cities").then(setCities).catch(() => {});
    api("/api/leads/timezones").then(setTimezones).catch(() => {});
  }, []);

  const act = async (id: string, path: string, ok = "Done") => {
    try {
      await api(`/api/campaigns/${id}/${path}`, { method: "POST" });
      toast.success(ok);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (c: Campaign) => {
    if (!window.confirm(`Delete "${c.name}"? Send history is kept but detached.`)) return;
    try {
      await api(`/api/campaigns/${c.id}`, { method: "DELETE" });
      toast.info("Deleted");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (editing)
    return (
      <Editor
        initial={editing}
        cities={cities}
        timezones={timezones}
        onClose={() => {
          setEditing(null);
          load();
        }}
      />
    );

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="A campaign is a sequence (initial email plus follow-ups) sent to the leads matching its filters, paced by the daily planner."
        actions={
          <>
            <Check checked={showArchived} onChange={setShowArchived} label="Show archived" />
            <Button onClick={() => setEditing({ ...EMPTY_DRAFT })}>New campaign</Button>
          </>
        }
      />

      <Card flush>
        {!campaigns ? (
          <Spinner />
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            action={<Button onClick={() => setEditing({ ...EMPTY_DRAFT })}>New campaign</Button>}
          >
            Write the first email and any follow-ups, preview them against real leads, then launch.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th className="text-right">Messages</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button className="link text-left" onClick={() => setEditing(toDraft(c))}>
                        {c.name}
                      </button>
                      {c.archivedAt && <span className="ml-2 text-xs text-muted">archived</span>}
                      {c.scheduledStartAt && c.status === "scheduled" && (
                        <div className="text-xs text-muted">
                          starts {new Date(c.scheduledStartAt).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge kind={STATUS_KIND(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="text-muted">
                      1 + {c.followUpsJson?.length ?? 0} follow-up{c.followUpsJson?.length === 1 ? "" : "s"}
                      {c.abEnabled && " · A/B"}
                    </td>
                    <td className="text-right tabular-nums">{c._count?.messages ?? 0}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(toDraft(c))}>
                          Open
                        </Button>
                        {c.abEnabled && (
                          <Button variant="ghost" size="sm" onClick={() => setAbFor(c)}>
                            A/B
                          </Button>
                        )}
                        {c.status === "running" ? (
                          <Button variant="ghost" size="sm" onClick={() => act(c.id, "pause", "Paused")}>
                            Pause
                          </Button>
                        ) : c.status === "paused" && !c.archivedAt ? (
                          <Button variant="ghost" size="sm" onClick={() => act(c.id, "resume", "Resumed")}>
                            Resume
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => act(c.id, "duplicate", "Duplicated")}>
                          Duplicate
                        </Button>
                        {c.archivedAt ? (
                          <Button variant="ghost" size="sm" onClick={() => act(c.id, "unarchive", "Unarchived")}>
                            Unarchive
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => act(c.id, "archive", "Archived")}>
                            Archive
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => remove(c)}>
                          <span className="text-bad">Delete</span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {abFor && <AbModal campaign={abFor} onClose={() => setAbFor(null)} />}
    </div>
  );
}

function AbModal({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const [report, setReport] = useState<AbReport | null>(null);
  useEffect(() => {
    api<AbReport>(`/api/campaigns/${campaign.id}/ab`).then(setReport).catch(() => {});
  }, [campaign.id]);
  const best =
    report && report.variants.length === 2
      ? report.variants.reduce((a, b) => (b.replyRate > a.replyRate ? b : a))
      : null;
  return (
    <Modal title={`A/B report · ${campaign.name}`} onClose={onClose}>
      {!report ? (
        <Spinner />
      ) : (
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Variant</th>
                <th className="text-right">Sent</th>
                <th className="text-right">Opens</th>
                <th className="text-right">Replies</th>
                <th className="text-right">Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {report.variants.map((v) => (
                <tr key={v.variant}>
                  <td className="font-medium">
                    {v.variant}{" "}
                    {best && v.variant === best.variant && v.sent > 0 && <Badge kind="green">leading</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{v.sent}</td>
                  <td className="text-right tabular-nums">{v.opens}</td>
                  <td className="text-right tabular-nums">{v.replies}</td>
                  <td className="text-right tabular-nums">{(v.replyRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

interface PlacementResult {
  test: {
    id: string;
    status: "pending" | "sent" | "done" | "error";
    error: string | null;
    resultsJson: { sender: string; seed: string; folder: string; error?: string }[];
  } | null;
  summary?: { total: number; inbox: number; spam: number; promotions: number; missing: number };
}

/**
 * Built-in inbox placement test panel. Sends the real rendered campaign email
 * between the connected inboxes and reports which folder Gmail filed it in.
 * Advisory only — a spam result warns but never blocks launch.
 */
function PlacementPanel({
  campaignId,
  ensureSaved,
}: {
  campaignId: string | null;
  ensureSaved: () => Promise<string | null>;
}) {
  const toast = useToast();
  const [data, setData] = useState<PlacementResult | null>(null);
  const [running, setRunning] = useState(false);

  const fetchLatest = async (id: string) => {
    try {
      const d = await api<PlacementResult>(`/api/campaigns/${id}/placement-test`);
      setData(d);
      return d;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    if (campaignId) fetchLatest(campaignId);
  }, [campaignId]);

  // Poll while a test is in flight.
  useEffect(() => {
    const status = data?.test?.status;
    if (!campaignId || (status !== "pending" && status !== "sent")) return;
    const t = setInterval(() => fetchLatest(campaignId), 10_000);
    return () => clearInterval(t);
  }, [campaignId, data?.test?.status]);

  const run = async () => {
    const id = campaignId ?? (await ensureSaved());
    if (!id) return;
    setRunning(true);
    try {
      await api(`/api/campaigns/${id}/placement-test`, { method: "POST" });
      toast.success("Placement test started. Results in about 5 minutes.");
      await fetchLatest(id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const test = data?.test;
  const s = data?.summary;
  const inFlight = test?.status === "pending" || test?.status === "sent";
  const folderTone = (f: string) => (f === "inbox" ? "text-ok" : f === "spam" ? "text-bad" : "text-warn");

  return (
    <Card
      title="Inbox placement test"
      description="Sends this email between your connected inboxes and checks which folder it lands in."
      actions={
        <Button variant="secondary" size="sm" onClick={run} disabled={running || inFlight}>
          {inFlight ? "Running…" : "Run test"}
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        {test?.status === "error" && <Callout tone="bad">{test.error}</Callout>}
        {inFlight && (
          <p className="text-muted">Test emails sent between your inboxes. Checking folders shortly…</p>
        )}
        {test?.status === "done" && s && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span className="text-ok">{s.inbox} inbox</span>
              <span className={s.spam > 0 ? "text-bad" : "text-muted"}>{s.spam} spam</span>
              <span className="text-warn">{s.promotions} promotions</span>
              <span className="text-muted">{s.missing} missing</span>
              <span className="text-muted">of {s.total}</span>
            </div>
            {s.spam > 0 && (
              <Callout tone="warn">
                Some copies landed in spam. Revise the copy, check SPF/DKIM/DMARC, or warm the inboxes longer
                before launching.
              </Callout>
            )}
            <ul className="space-y-0.5 text-xs text-muted">
              {(test.resultsJson ?? []).map((p, i) => (
                <li key={i}>
                  {p.sender} → {p.seed}: <span className={folderTone(p.folder)}>{p.folder}</span>
                  {p.error && <span className="text-bad"> — {p.error}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {!test && !inFlight && <p className="text-muted">No test run yet. Needs two or more connected inboxes.</p>}
        <p className="text-xs text-muted">
          Gmail-only (your inboxes are the seeds). For Outlook/Yahoo coverage try{" "}
          <a className="link" href="https://www.mail-tester.com" target="_blank" rel="noreferrer">
            mail-tester.com
          </a>{" "}
          or{" "}
          <a className="link" href="https://glockapps.com/spam-testing/" target="_blank" rel="noreferrer">
            GlockApps
          </a>
          .
        </p>
      </div>
    </Card>
  );
}

const SAMPLE_NOTE: Record<string, string> = {
  eligible: "Rendered against real leads this campaign hasn't emailed yet.",
  matching: "No un-emailed leads left for these filters — showing leads this campaign already contacted.",
  any: "No leads match these filters — showing your most recent leads instead.",
  placeholder: "No leads yet — showing a placeholder contact.",
};

interface Preview {
  eligibleCount: number;
  dailyBudget: number;
  etaBusinessDays: number;
  sampleSource: string;
  isHtml: boolean;
  signatureApplied: boolean;
  footerMode: string;
  steps: { key: string; label: string; samples: { to: string; subject: string; body: string }[] }[];
}

/**
 * Pre-send preview. Renders the complete email exactly as the worker composes
 * it (body + inbox signature + footer), per variant and per follow-up step.
 * Updates as you type; never requires the campaign to be saved or sent.
 */
function LivePreview({
  preview,
  error,
  activeStep,
  onStep,
}: {
  preview: Preview | null;
  error: string;
  activeStep: number;
  onStep: (i: number) => void;
}) {
  if (error) return <Callout tone="bad">Preview failed: {error}</Callout>;
  if (!preview)
    return (
      <Card>
        <Spinner label="Building preview…" />
      </Card>
    );

  const steps = preview.steps ?? [];
  const step = steps[activeStep] ?? steps[0];
  const eta = Number.isFinite(preview.etaBusinessDays) ? `~${preview.etaBusinessDays} business days` : "no capacity";

  return (
    <Card
      title="Preview"
      description={`${preview.eligibleCount} eligible leads · ${preview.dailyBudget}/day budget · ${eta}`}
      flush
    >
      {steps.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-line px-5 py-3">
          {steps.map((s, i) => (
            <button
              key={s.key}
              onClick={() => onStep(i)}
              className={cx(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                i === activeStep ? "bg-accent/10 text-accent" : "text-muted hover:bg-subtle hover:text-fg",
              )}
            >
              {s.key === "a" ? "Initial" : s.key === "b" ? "Variant B" : `Follow-up ${Number(s.key.slice(1)) + 1}`}
            </button>
          ))}
        </div>
      )}

      <div className="border-b border-line px-5 py-2 text-xs text-muted">
        {step?.label} · {SAMPLE_NOTE[preview.sampleSource] ?? ""}
        {preview.footerMode === "none" && " · no footer"}
        {preview.signatureApplied && " · inbox signature included"}
      </div>

      <div className="max-h-[560px] divide-y divide-line overflow-y-auto">
        {(step?.samples ?? []).map((s, i) => (
          <div key={i} className="space-y-2 px-5 py-4">
            <div className="text-xs text-muted">
              To: <span className="text-fg">{s.to}</span>
            </div>
            <div className="border-b border-line pb-2 text-sm font-semibold">
              {s.subject || <span className="font-normal italic text-muted">(empty subject)</span>}
            </div>
            {preview.isHtml ? (
              <div
                className="text-sm leading-relaxed [&_a]:text-accent [&_a]:underline"
                dangerouslySetInnerHTML={{ __html: s.body }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                {s.body || "(empty body)"}
              </pre>
            )}
          </div>
        ))}
        {(step?.samples ?? []).length === 0 && (
          <div className="px-5 py-6 text-sm text-muted">Nothing to render yet — type a subject and body.</div>
        )}
      </div>
    </Card>
  );
}

function CharCount({ value }: { value: string }) {
  const chars = value?.length ?? 0;
  const words = value?.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div className="mt-1 text-right text-xs text-muted">
      {words} words · {chars} chars
    </div>
  );
}

const MERGE_HINT = "Merge fields: {{firstName}} {{name}} {{company}} {{title}} {{city}} {{state}} plus any imported column. Spintax: {Hi|Hello}.";

function Editor({
  initial,
  cities,
  timezones,
  onClose,
}: {
  initial: Draft;
  cities: { city: string; count: number }[];
  timezones: { timezone: string; count: number }[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [c, setC] = useState<Draft>(initial);
  // Footer: null = default sender footer, "" = none, text = custom.
  const [footerMode, setFooterMode] = useState<FooterMode>(
    initial.footerOverride == null ? "default" : initial.footerOverride === "" ? "none" : "custom",
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [activeStep, setActiveStep] = useState(0);
  const [confirmTest, setConfirmTest] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setC((p) => ({ ...p, [k]: v }));
  const locked = c.status === "running";

  const footerOverride =
    footerMode === "default" ? null : footerMode === "none" ? "" : (c.footerOverride ?? "");
  const filters = {
    ...(c.cities.length ? { cities: c.cities } : {}),
    ...(c.timezones.length ? { timezones: c.timezones } : {}),
  };

  /**
   * Live preview. Debounced so it doesn't fire per keystroke, and it does NOT
   * save the campaign first — the server renders the draft as posted.
   */
  const previewPayload = JSON.stringify({
    id: c.id,
    regionId: null,
    subjectTemplate: c.subjectTemplate ?? "",
    bodyTemplate: c.bodyTemplate ?? "",
    subjectVariantB: c.subjectVariantB ?? null,
    bodyVariantB: c.bodyVariantB ?? null,
    abEnabled: !!c.abEnabled,
    followUps: c.followUps ?? [],
    filters,
    isHtml: !!c.isHtml,
    footerOverride,
  });

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api<Preview>("/api/campaigns/preview", { method: "POST", body: previewPayload })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewErr("");
          setActiveStep((s) => Math.min(s, Math.max(0, (p.steps?.length ?? 1) - 1)));
        })
        .catch((e) => {
          if (!cancelled) setPreviewErr((e as Error).message);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [previewPayload]);

  const save = async (quiet = false): Promise<string | null> => {
    setErr("");
    if (!c.name?.trim() || !c.subjectTemplate?.trim() || !c.bodyTemplate?.trim()) {
      setErr("Fill in the campaign name, subject and body before saving.");
      return null;
    }
    const payload = {
      name: c.name,
      regionId: null,
      subjectTemplate: c.subjectTemplate,
      bodyTemplate: c.bodyTemplate,
      subjectVariantB: c.subjectVariantB || null,
      bodyVariantB: c.bodyVariantB || null,
      abEnabled: !!c.abEnabled,
      followUps: c.followUps ?? [],
      // Only keys that are actually set, so an untouched campaign keeps an
      // empty filter object.
      filters,
      isHtml: !!c.isHtml,
      trackOpens: !!c.trackOpens,
      trackClicks: !!c.trackClicks,
      unsubHeader: !!c.unsubHeader,
      footerOverride,
    };
    setSaving(true);
    try {
      const saved = c.id
        ? await api<Campaign>(`/api/campaigns/${c.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<Campaign>("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
      setC((p) => ({ ...p, id: saved.id, status: saved.status }));
      if (!quiet) toast.success("Saved");
      return saved.id;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const launch = async () => {
    setErr("");
    const id = locked ? c.id! : await save(true);
    if (!id) return;
    try {
      if (startAt) {
        await api(`/api/campaigns/${id}/schedule`, {
          method: "POST",
          body: JSON.stringify({ startAt: new Date(startAt).toISOString(), placementTestConfirmed: confirmTest }),
        });
        toast.success("Campaign scheduled");
      } else {
        await api(`/api/campaigns/${id}/launch`, {
          method: "POST",
          body: JSON.stringify({ placementTestConfirmed: confirmTest }),
        });
        toast.success("Campaign launched. The planner is slotting sends now.");
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setStep = (i: number, patch: Partial<FollowUpStep>) =>
    set(
      "followUps",
      c.followUps.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    );

  return (
    <div>
      <PageHeader
        title={c.id ? c.name || "Edit campaign" : "New campaign"}
        description={c.status ? <Badge kind={STATUS_KIND(c.status)}>{c.status}</Badge> : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={onClose}>
              Back to campaigns
            </Button>
            <Button variant="secondary" onClick={() => save()} disabled={saving || locked}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
          </>
        }
      />

      {locked && (
        <div className="mb-4">
          <Callout tone="warn">This campaign is running. Pause it before editing; changes are blocked while live.</Callout>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card title="Basics">
            <div className="space-y-4">
              <Field label="Campaign name">
                <input className="input" value={c.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Cities ${c.cities.length ? `(${c.cities.length})` : "· all"}`}>
                  <select
                    multiple
                    size={6}
                    className="input"
                    value={c.cities}
                    onChange={(e) => set("cities", [...e.target.selectedOptions].map((o) => o.value))}
                  >
                    {cities.map((x) => (
                      <option key={x.city} value={x.city}>
                        {x.city} ({x.count})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Timezones ${c.timezones.length ? `(${c.timezones.length})` : "· all"}`}>
                  <select
                    multiple
                    size={6}
                    className="input"
                    value={c.timezones}
                    onChange={(e) => set("timezones", [...e.target.selectedOptions].map((o) => o.value))}
                  >
                    {timezones.map((t) => (
                      <option key={t.timezone} value={t.timezone}>
                        {t.timezone} ({t.count})
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="text-xs text-muted">
                Ctrl/Cmd-click to pick several. Nothing selected means no filter on that field; selecting both
                means a lead must match a city <em>and</em> a timezone. Only leads with status{" "}
                <code className="kbd">pending</code> are emailed.
              </p>
            </div>
          </Card>

          <Card title="Initial email" description={MERGE_HINT}>
            <div className="space-y-4">
              <Field label="Subject">
                <input
                  className="input"
                  placeholder="Quick question, {{firstName}}"
                  value={c.subjectTemplate}
                  onChange={(e) => set("subjectTemplate", e.target.value)}
                />
              </Field>
              <Field label="Body">
                <textarea
                  className="input font-[inherit]"
                  rows={12}
                  spellCheck
                  placeholder={"{Hi|Hello} {{firstName}},\n\n…"}
                  value={c.bodyTemplate}
                  onChange={(e) => set("bodyTemplate", e.target.value)}
                />
                <CharCount value={c.bodyTemplate ?? ""} />
              </Field>

              <Check checked={!!c.abEnabled} onChange={(v) => set("abEnabled", v)} label="A/B test a second variant" />
              {c.abEnabled && (
                <div className="space-y-4 rounded-lg border border-line p-4">
                  <Field label="Variant B subject">
                    <input
                      className="input"
                      value={c.subjectVariantB ?? ""}
                      onChange={(e) => set("subjectVariantB", e.target.value)}
                    />
                  </Field>
                  <Field label="Variant B body">
                    <textarea
                      className="input"
                      rows={8}
                      spellCheck
                      value={c.bodyVariantB ?? ""}
                      onChange={(e) => set("bodyVariantB", e.target.value)}
                    />
                    <CharCount value={c.bodyVariantB ?? ""} />
                  </Field>
                </div>
              )}
            </div>
          </Card>

          <Card
            title="Follow-ups"
            description="Sent in the same thread if there's no reply. Canceled automatically on reply, bounce or unsubscribe."
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  set("followUps", [...c.followUps, { dayOffset: 3, subjectTemplate: "", bodyTemplate: "" }])
                }
              >
                Add step
              </Button>
            }
          >
            {c.followUps.length === 0 ? (
              <p className="text-sm text-muted">No follow-ups. Most replies come from the second or third touch.</p>
            ) : (
              <div className="space-y-5">
                {c.followUps.map((f, i) => (
                  <div key={i} className="space-y-3 border-l-2 border-accent/40 pl-4">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">Step {i + 2}</span>
                      <span className="text-muted">· wait</span>
                      <input
                        type="number"
                        min={1}
                        className="input w-20"
                        value={f.dayOffset}
                        onChange={(e) => setStep(i, { dayOffset: Number(e.target.value) })}
                      />
                      <span className="text-muted">days after the previous step</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => set("followUps", c.followUps.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </div>
                    <input
                      className="input"
                      placeholder="Subject (sent as a reply: Re: …)"
                      value={f.subjectTemplate}
                      onChange={(e) => setStep(i, { subjectTemplate: e.target.value })}
                    />
                    <textarea
                      className="input"
                      rows={6}
                      spellCheck
                      placeholder="Body"
                      value={f.bodyTemplate}
                      onChange={(e) => setStep(i, { bodyTemplate: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Delivery options">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <Check checked={!!c.isHtml} onChange={(v) => set("isHtml", v)} label="HTML email" />
                <Check
                  checked={!!c.trackOpens}
                  onChange={(v) => set("trackOpens", v)}
                  label="Track opens"
                  title="Adds an invisible open pixel (HTML only). Tracking can hurt deliverability."
                />
                <Check
                  checked={!!c.trackClicks}
                  onChange={(v) => set("trackClicks", v)}
                  label="Track clicks"
                  title="Rewrites links through a redirect (HTML only). Tracking can hurt deliverability."
                />
                <Check
                  checked={!!c.unsubHeader}
                  onChange={(v) => set("unsubHeader", v)}
                  label="List-Unsubscribe header"
                  title="Adds RFC 8058 one-click unsubscribe headers. Off reads more person-to-person; on is safer at higher volume."
                />
              </div>
              <Field label="Footer">
                <select className="input" value={footerMode} onChange={(e) => setFooterMode(e.target.value as FooterMode)}>
                  <option value="default">Default sender footer (from SENDER_* settings)</option>
                  <option value="custom">Custom footer</option>
                  <option value="none">No footer</option>
                </select>
              </Field>
              {footerMode === "custom" && (
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Your footer text"
                  value={c.footerOverride ?? ""}
                  onChange={(e) => set("footerOverride", e.target.value)}
                />
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <LivePreview preview={preview} error={previewErr} activeStep={activeStep} onStep={setActiveStep} />

          <PlacementPanel campaignId={c.id ?? null} ensureSaved={() => save(true)} />

          {!locked && (
            <Card title="Launch">
              <div className="space-y-4">
                <Check
                  checked={confirmTest}
                  onChange={setConfirmTest}
                  label="I ran a placement test and nothing landed in spam."
                />
                <Field label="Start" hint="Leave empty to start now. Sends never fire in a burst either way.">
                  <input
                    type="datetime-local"
                    className="input"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                  />
                </Field>
                <Button onClick={launch} disabled={!confirmTest}>
                  {startAt ? "Schedule campaign" : "Launch campaign"}
                </Button>
                <p className="text-xs text-muted">
                  The planner spreads sends over days, inside each recipient's working hours, within every
                  inbox's daily cap.
                </p>
              </div>
            </Card>
          )}
          {err && <Callout tone="bad">{err}</Callout>}
        </div>
      </div>
    </div>
  );
}
