import React, { useEffect, useState, useRef } from "react";
import { api, uploadLeads, download } from "../api.js";
import {
  Card,
  Badge,
  Button,
  Check,
  Field,
  Modal,
  PageHeader,
  EmptyState,
  Callout,
  Spinner,
  type Tone,
} from "../components.js";
import { useToast } from "../toast.js";
import { navigate } from "../router.js";
import type { Account, Lead, Region } from "../types.js";

// Offered in the import and bulk-edit timezone pickers. Any zone already
// present on a lead is merged in at runtime, so this never has to be complete.
const TZ_CHOICES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

// Sentinel for the "Custom…" entry — a real value would collide with a zone.
const TZ_CUSTOM = "__custom__";

/** Same check the server runs: a zone the runtime doesn't know is unusable. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

const TZ_STORAGE_KEY = "trickle.import.timezone";
const REGION_STORAGE_KEY = "trickle.import.regionId";

export const STATUS_KIND: Record<string, Tone> = {
  pending: "gray",
  contacted: "blue",
  followup: "blue",
  replied: "green",
  bounced: "red",
  unsubscribed: "yellow",
  do_not_contact: "yellow",
};

type LeadRow = Lead & { region?: { name: string } | null; account?: { email: string } | null };

export default function Leads() {
  const toast = useToast();
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionId, setRegionId] = useState(() => readPref(REGION_STORAGE_KEY));
  // Explicit timezone for the next import ("" = derive per row).
  const [importTz, setImportTz] = useState(() => readPref(TZ_STORAGE_KEY));
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [tzOptions, setTzOptions] = useState<string[]>(TZ_CHOICES);
  // Free-text IANA entry, for zones not in the list yet. Validated locally
  // before it can be applied; the server validates again on write.
  const [customTz, setCustomTz] = useState("");
  const [showCustomTz, setShowCustomTz] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [composeLead, setComposeLead] = useState<LeadRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const PAGE = 200;

  // reset=true replaces the list (new search/filter/import); otherwise append.
  const load = (reset = true) => {
    const skip = reset ? 0 : (leads?.length ?? 0);
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (status) p.set("status", status);
    p.set("take", String(PAGE));
    p.set("skip", String(skip));
    api<{ total: number; leads: LeadRow[] }>(`/api/leads?${p.toString()}`)
      .then((r) => {
        setLeads((prev) => (reset ? r.leads : [...(prev ?? []), ...r.leads]));
        setTotal(r.total);
      })
      .catch((e) => toast.error((e as Error).message));
  };

  useEffect(() => {
    api<Region[]>("/api/regions").then(setRegions).catch(() => {});
    api<Account[]>("/api/accounts")
      .then((a) => setAccounts(a.filter((x) => x.connected)))
      .catch(() => {});
    // Merge zones already in use with the static list, so an unusual zone set
    // earlier stays selectable.
    api<{ timezone: string; count: number }[]>("/api/leads/timezones")
      .then((rows) => setTzOptions([...new Set([...TZ_CHOICES, ...rows.map((r) => r.timezone)])]))
      .catch(() => {});
  }, []);

  // Remember the last import choices across visits.
  useEffect(() => writePref(TZ_STORAGE_KEY, importTz), [importTz]);
  useEffect(() => writePref(REGION_STORAGE_KEY, regionId), [regionId]);
  useEffect(() => {
    const t = setTimeout(() => load(true), 300);
    return () => clearTimeout(t);
  }, [search, status]);

  const exportCsv = () => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (status) p.set("status", status);
    download(`/api/leads/export?${p.toString()}`, `leads-${Date.now()}.csv`).catch((e) =>
      toast.error((e as Error).message),
    );
  };

  const bulk = async (path: string, body: Record<string, unknown>, done: (n: number) => string) => {
    if (selected.size === 0) return;
    try {
      const r = await api<{ updated: number }>(`/api/leads/${path}`, {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], ...body }),
      });
      toast.success(done(r.updated));
      setSelected(new Set());
      load(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Select every lead matching the current search/status filter, not just the
  // rows paged into view.
  const selectAllMatching = async () => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (status) p.set("status", status);
    const r = await api<{ ids: string[] }>(`/api/leads/ids?${p.toString()}`);
    setSelected(new Set(r.ids));
    toast.success(`Selected ${r.ids.length} lead(s)`);
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const deleteOne = async (id: string) => {
    if (!confirm("Delete this lead? This also removes its message history.")) return;
    await api(`/api/leads/${id}`, { method: "DELETE" });
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    load(true);
  };

  const clearAll = async () => {
    if (total === 0) return;
    if (!confirm(`Delete ALL ${total} leads? Their message history goes too. This cannot be undone.`)) return;
    const typed = prompt(`Type DELETE to confirm wiping all ${total} leads:`);
    if (typed !== "DELETE") return;
    const r = await api<{ deleted: number }>("/api/leads/clear-all", { method: "POST" });
    setSelected(new Set());
    toast.info(`Deleted ${r.deleted} leads.`);
    load(true);
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected lead(s) and their message history?`)) return;
    await api("/api/leads/bulk-delete", { method: "POST", body: JSON.stringify({ ids: [...selected] }) });
    setSelected(new Set());
    load(true);
  };

  // Picking a file only stages it; the import waits for an explicit click so
  // region/timezone can still be changed after the file is chosen.
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStagedFile(e.target.files?.[0] ?? null);
    setMsg(null);
  };

  const cancelStaged = () => {
    setStagedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const runImport = async () => {
    if (!stagedFile || importing) return;
    setImporting(true);
    setMsg({ tone: "info", text: "Importing…" });
    try {
      const r = await uploadLeads(stagedFile, regionId || undefined, importTz || undefined);
      const applied = r.appliedTimezone
        ? ` All set to ${r.appliedTimezone}${r.appliedRegion ? ` (${r.appliedRegion})` : ""}.`
        : " Timezones taken from each row.";
      setMsg({
        tone: "ok",
        text: `Imported ${r.imported} of ${r.total}.${applied} Skipped ${r.skippedDupe} duplicate or suppressed, ${r.skippedInvalid} invalid.`,
      });
      cancelStaged();
      load(true);
    } catch (err) {
      setMsg({ tone: "bad", text: `Import failed: ${(err as Error).message}` });
    } finally {
      setImporting(false);
    }
  };

  // What the staged file will actually get, mirroring the server's precedence.
  const selectedRegion = regions.find((r) => r.id === regionId);
  const effectiveTz = importTz || selectedRegion?.timezone || null;

  const tzPicker = (
    <select
      value={showCustomTz ? TZ_CUSTOM : importTz}
      onChange={(e) => {
        if (e.target.value === TZ_CUSTOM) {
          setShowCustomTz(true);
          setCustomTz(importTz);
        } else {
          setShowCustomTz(false);
          setImportTz(e.target.value);
        }
      }}
      className="input"
    >
      <option value="">Auto: timezone column, region, or US state</option>
      {tzOptions.map((tz) => (
        <option key={tz} value={tz}>
          {tz}
        </option>
      ))}
      <option value={TZ_CUSTOM}>Custom…</option>
    </select>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Everyone you might email. Deduped by address; suppressed addresses are never imported."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowAdd(true)}>
              Add lead
            </Button>
            <Button onClick={() => setShowImport((s) => !s)}>{showImport ? "Hide import" : "Import CSV / XLSX"}</Button>
          </>
        }
      />

      {showImport && (
        <Card
          title="Import leads"
          description="Columns are matched by header: email (required), name or first/last name, company, title, city, state, zip, timezone. Every other column is kept as a custom field you can use as {{Column Name}}."
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Region (optional)">
              <select value={regionId} onChange={(e) => setRegionId(e.target.value)} className="input">
                <option value="">No region</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timezone for this import">{tzPicker}</Field>
            <Field label="File">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={onFile}
                className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium file:text-fg hover:file:bg-subtle"
              />
            </Field>
          </div>

          {showCustomTz && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Field label="IANA timezone, e.g. Europe/London" className="w-72">
                <input
                  value={customTz}
                  onChange={(e) => setCustomTz(e.target.value)}
                  placeholder="Area/City"
                  spellCheck={false}
                  className="input"
                />
              </Field>
              <Button
                onClick={() => {
                  const tz = customTz.trim();
                  if (!isValidTimezone(tz)) {
                    toast.error(`Not a valid IANA timezone: ${tz || "(empty)"}`);
                    return;
                  }
                  setTzOptions((o) => [...new Set([...o, tz])]);
                  setImportTz(tz);
                  setShowCustomTz(false);
                  setCustomTz("");
                }}
              >
                Use
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCustomTz(false);
                  setCustomTz("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {stagedFile && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
              <span className="font-medium">{stagedFile.name}</span>
              <span className="text-muted">
                {effectiveTz ? `Every lead → ${effectiveTz}` : "Timezone per row"}
                {selectedRegion ? ` · region ${selectedRegion.name}` : ""}
              </span>
              <div className="ml-auto flex gap-2">
                <Button variant="secondary" size="sm" onClick={cancelStaged} disabled={importing}>
                  Cancel
                </Button>
                <Button size="sm" onClick={runImport} disabled={importing}>
                  {importing ? "Importing…" : "Import"}
                </Button>
              </div>
            </div>
          )}
          {msg && (
            <div className="mt-4">
              <Callout tone={msg.tone}>{msg.text}</Callout>
            </div>
          )}
        </Card>
      )}

      <Card
        flush
        title={`${total} lead${total === 1 ? "" : "s"}`}
        description={leads && leads.length < total ? `Showing ${leads.length}` : undefined}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button variant="danger" size="sm" onClick={clearAll}>
              Delete all
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row">
          <input
            placeholder="Search email, name or company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input md:flex-1"
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input md:w-48">
            <option value="">All statuses</option>
            {Object.keys(STATUS_KIND).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {total > 0 && (
            <Button variant="secondary" onClick={selectAllMatching}>
              Select all {total}
            </Button>
          )}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-5 py-3 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulk("bulk-status", { status: v }, (n) => `Updated ${n} lead(s) to ${v}`);
              }}
              className="input w-auto py-1.5"
            >
              <option value="">Set status…</option>
              {Object.keys(STATUS_KIND).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulk("bulk-region", { regionId: v === "__clear__" ? null : v }, (n) => `Reassigned ${n} lead(s)`);
              }}
              className="input w-auto py-1.5"
            >
              <option value="">Set region…</option>
              <option value="__clear__">(clear region)</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v === TZ_CUSTOM) {
                  const entered = prompt("IANA timezone to apply, e.g. Europe/London")?.trim();
                  if (!entered) return;
                  if (!isValidTimezone(entered)) {
                    toast.error(`Not a valid IANA timezone: ${entered}`);
                    return;
                  }
                  setTzOptions((o) => [...new Set([...o, entered])]);
                  bulk("bulk-timezone", { timezone: entered }, (n) => `Set ${n} lead(s) to ${entered}`);
                  return;
                }
                if (v) bulk("bulk-timezone", { timezone: v }, (n) => `Set ${n} lead(s) to ${v}`);
              }}
              className="input w-auto py-1.5"
            >
              <option value="">Set timezone…</option>
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
              <option value={TZ_CUSTOM}>Custom…</option>
            </select>
            <select
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                e.target.value = "";
                if (v) bulk("bulk-account", { accountId: v === "__clear__" ? null : v }, (n) => `Reassigned ${n} lead(s)`);
              }}
              className="input w-auto py-1.5"
            >
              <option value="">Set inbox…</option>
              <option value="__clear__">(unassign, round-robin)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
            <Button variant="danger" size="sm" onClick={deleteSelected}>
              Delete {selected.size}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {!leads ? (
          <Spinner />
        ) : leads.length === 0 ? (
          <EmptyState
            title={search || status ? "No leads match" : "No leads yet"}
            action={!search && !status ? <Button onClick={() => setShowImport(true)}>Import leads</Button> : undefined}
          >
            {!search && !status && "Import a CSV or XLSX, or add a lead by hand."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      className="checkbox"
                      aria-label="Select page"
                      checked={leads.length > 0 && leads.every((l) => selected.has(l.id))}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          for (const l of leads) {
                            if (e.target.checked) n.add(l.id);
                            else n.delete(l.id);
                          }
                          return n;
                        })
                      }
                    />
                  </th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Company</th>
                  <th>City</th>
                  <th>Timezone</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggle(l.id)}
                        aria-label={`Select ${l.email}`}
                      />
                    </td>
                    <td className="whitespace-nowrap">
                      <button className="link" onClick={() => navigate(`/leads/${l.id}`)}>
                        {l.email}
                      </button>
                    </td>
                    <td className="whitespace-nowrap">{l.name ?? <span className="text-muted">—</span>}</td>
                    <td className="whitespace-nowrap text-muted">{l.company ?? "—"}</td>
                    <td className="whitespace-nowrap text-muted">
                      {[l.city, l.state].filter(Boolean).join(", ") || "—"}
                      {l.region?.name && <span className="ml-1 text-xs">· {l.region.name}</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted" title={l.timezone}>
                      {l.timezone}
                    </td>
                    <td>
                      <Badge kind={STATUS_KIND[l.status] ?? "gray"}>{l.status}</Badge>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setComposeLead(l)}>
                          Email
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteOne(l.id)}>
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
        {leads && leads.length < total && (
          <div className="flex justify-center border-t border-line p-4">
            <Button variant="secondary" onClick={() => load(false)}>
              Load more ({total - leads.length} remaining)
            </Button>
          </div>
        )}
      </Card>

      {showAdd && (
        <AddLeadModal
          regions={regions}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            toast.success("Lead added");
            load(true);
          }}
        />
      )}

      {composeLead && (
        <ComposeModal
          lead={composeLead}
          accounts={accounts}
          onClose={() => setComposeLead(null)}
          onSent={() => {
            setComposeLead(null);
            toast.success("Email queued");
            load(true);
          }}
        />
      )}
    </div>
  );
}

function AddLeadModal({
  regions,
  onClose,
  onAdded,
}: {
  regions: Region[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [f, setF] = useState({
    name: "",
    email: "",
    company: "",
    title: "",
    city: "",
    state: "",
    zip: "",
    regionId: "",
    timezone: "",
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr("");
    if (!f.email.trim()) {
      setErr("Email is required.");
      return;
    }
    if (f.timezone.trim() && !isValidTimezone(f.timezone.trim())) {
      setErr(`Unknown timezone: ${f.timezone}`);
      return;
    }
    try {
      await api("/api/leads", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          regionId: f.regionId || undefined,
          timezone: f.timezone.trim() || undefined,
        }),
      });
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal
      title="Add a lead"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Add lead</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email *" className="sm:col-span-2">
          <input className="input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} autoFocus />
        </Field>
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Company">
          <input className="input" value={f.company} onChange={(e) => set("company", e.target.value)} />
        </Field>
        <Field label="Title">
          <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={(e) => set("city", e.target.value)} />
        </Field>
        <Field label="State / province">
          <input className="input" value={f.state} onChange={(e) => set("state", e.target.value)} />
        </Field>
        <Field label="Zip / postcode">
          <input className="input" value={f.zip} onChange={(e) => set("zip", e.target.value)} />
        </Field>
        <Field label="Region">
          <select className="input" value={f.regionId} onChange={(e) => set("regionId", e.target.value)}>
            <option value="">None</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone" hint="Blank = from region or US state, else the server default.">
          <input
            className="input"
            placeholder="e.g. Europe/London"
            value={f.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </Field>
      </div>
      {err && (
        <div className="mt-4">
          <Callout tone="bad">{err}</Callout>
        </div>
      )}
    </Modal>
  );
}

export function ComposeModal({
  lead,
  accounts,
  onClose,
  onSent,
}: {
  lead: { id: string; email: string; name: string | null; account?: { id?: string; email: string } | null };
  accounts: Account[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [accountId, setAccountId] = useState(lead.account?.id ?? accounts[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isHtml, setIsHtml] = useState(false);
  const [trackOpens, setTrackOpens] = useState(false);
  const [trackClicks, setTrackClicks] = useState(false);
  const [unsubHeader, setUnsubHeader] = useState(false);
  // "default" = sender footer, "custom" = write your own, "none" = no footer
  const [footerMode, setFooterMode] = useState<"default" | "custom" | "none">("default");
  const [customFooter, setCustomFooter] = useState("");
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    setErr("");
    if (!accountId) {
      setErr("Connect an inbox first (Inboxes page).");
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setErr("Subject and body are required.");
      return;
    }
    setSending(true);
    try {
      const footerOverride = footerMode === "default" ? null : footerMode === "none" ? "" : customFooter;
      await api(`/api/leads/${lead.id}/send`, {
        method: "POST",
        body: JSON.stringify({ accountId, subject, body, isHtml, trackOpens, trackClicks, unsubHeader, footerOverride }),
      });
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      title={`Email ${lead.name ?? lead.email}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Send now"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="To">
            <input className="input" value={lead.email} disabled />
          </Field>
          <Field label="From inbox">
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Select a sending inbox…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Subject">
          <input className="input" placeholder="{{firstName}} works here" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Body" hint="Merge fields and custom fields work here too.">
          <textarea className="input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Check checked={isHtml} onChange={setIsHtml} label="HTML email" />
          <Check checked={trackOpens} onChange={setTrackOpens} disabled={!isHtml} label="Track opens" />
          <Check checked={trackClicks} onChange={setTrackClicks} disabled={!isHtml} label="Track clicks" />
          <Check checked={unsubHeader} onChange={setUnsubHeader} label="List-Unsubscribe header" />
        </div>
        <Field label="Footer">
          <select className="input" value={footerMode} onChange={(e) => setFooterMode(e.target.value as "default" | "custom" | "none")}>
            <option value="default">Default sender footer</option>
            <option value="custom">Custom footer</option>
            <option value="none">No footer</option>
          </select>
        </Field>
        {footerMode === "custom" && (
          <textarea className="input" rows={3} placeholder="Your footer text" value={customFooter} onChange={(e) => setCustomFooter(e.target.value)} />
        )}
        <p className="text-xs text-muted">
          Goes through the normal send pipeline: suppression check, footer, and dry-run mode all apply.
        </p>
        {err && <Callout tone="bad">{err}</Callout>}
      </div>
    </Modal>
  );
}
