import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Button, Card, PageHeader, Spinner, EmptyState } from "../components.js";
import { useToast } from "../toast.js";
import type { BlocklistEntry } from "../types.js";

export default function Blocklist() {
  const toast = useToast();
  const [entries, setEntries] = useState<BlocklistEntry[] | null>(null);
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");

  const load = () =>
    api<BlocklistEntry[]>("/api/blocklist")
      .then(setEntries)
      .catch((e) => toast.error((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!domain.trim()) return;
    try {
      await api("/api/blocklist", { method: "POST", body: JSON.stringify({ domain, note }) });
      setDomain("");
      setNote("");
      toast.success("Domain blocked");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (d: string) => {
    await api(`/api/blocklist/${encodeURIComponent(d)}`, { method: "DELETE" });
    toast.info("Removed from blocklist");
    load();
  };

  return (
    <div>
      <PageHeader
        title="Domain blocklist"
        description="Leads whose email domain is listed here are never emailed. Broader than the suppression list — useful for customers, partners and competitors."
      />
      <Card flush>
        <form
          className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com (or any address at it)"
            className="input md:w-80"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="input md:flex-1"
          />
          <Button type="submit">Block domain</Button>
        </form>
        {!entries ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <EmptyState title="No blocked domains" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Note</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="font-medium">{e.domain}</td>
                    <td className="text-muted">{e.note}</td>
                    <td className="whitespace-nowrap text-muted">{new Date(e.createdAt).toLocaleDateString()}</td>
                    <td className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove(e.domain)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
