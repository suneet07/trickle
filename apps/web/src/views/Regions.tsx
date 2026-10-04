import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Button, Card, Field, Modal, PageHeader, Spinner, EmptyState } from "../components.js";
import { useToast } from "../toast.js";
import type { Region } from "../types.js";

interface Draft {
  id?: string;
  name: string;
  states: string;
  timezone: string;
}

export default function Regions() {
  const toast = useToast();
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = () =>
    api<Region[]>("/api/regions")
      .then(setRegions)
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!editing) return;
    const payload = {
      name: editing.name.trim(),
      states: editing.states
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      timezone: editing.timezone.trim(),
    };
    if (!payload.name || !payload.timezone) {
      toast.error("Name and timezone are required.");
      return;
    }
    try {
      if (editing.id) await api(`/api/regions/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/regions", { method: "POST", body: JSON.stringify(payload) });
      toast.success("Saved");
      setEditing(null);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const del = async (r: Region) => {
    if (!window.confirm(`Delete region "${r.name}"? Leads keep their data but lose the region.`)) return;
    const res = await api<{ detachedLeads: number }>(`/api/regions/${r.id}`, { method: "DELETE" });
    toast.info(`Deleted (${res.detachedLeads} leads detached)`);
    load();
  };

  const newRegion = () =>
    setEditing({ name: "", states: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  return (
    <div>
      <PageHeader
        title="Regions"
        description="Optional groups of leads sharing a timezone. Imports auto-assign a region when a lead's state/province code matches."
        actions={<Button onClick={newRegion}>New region</Button>}
      />
      <Card flush>
        {!regions ? (
          <Spinner />
        ) : regions.length === 0 ? (
          <EmptyState title="No regions" action={<Button onClick={newRegion}>New region</Button>}>
            You don't need regions: every lead has its own timezone. They help when you import by territory.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State / province codes</th>
                  <th>Timezone</th>
                  <th className="text-right">Leads</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {regions.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.name}</td>
                    <td className="text-muted">{r.states.join(", ") || "—"}</td>
                    <td className="text-muted">{r.timezone}</td>
                    <td className="text-right tabular-nums">{r._count?.leads ?? 0}</td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setEditing({ id: r.id, name: r.name, states: r.states.join(", "), timezone: r.timezone })
                          }
                        >
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => del(r)}>
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

      {editing && (
        <Modal
          title={editing.id ? "Edit region" : "New region"}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={save}>Save</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name">
              <input
                className="input"
                placeholder="e.g. Pacific Northwest"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="State / province codes" hint="Comma-separated, e.g. WA, OR. Leave empty to assign leads manually.">
              <input
                className="input"
                value={editing.states}
                onChange={(e) => setEditing({ ...editing, states: e.target.value })}
              />
            </Field>
            <Field label="Timezone (IANA)" hint="e.g. America/Los_Angeles, Europe/Berlin">
              <input
                className="input"
                value={editing.timezone}
                onChange={(e) => setEditing({ ...editing, timezone: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
