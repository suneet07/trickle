import { useEffect, useState } from "react";
import { api, download } from "../api.js";
import { Card, Badge, Button, PageHeader, EmptyState, Spinner, Pagination, type Tone } from "../components.js";
import { useToast } from "../toast.js";
import type { Suppression } from "../types.js";

const REASON_KIND: Record<string, Tone> = {
  unsub: "yellow",
  bounce: "red",
  complaint: "red",
  manual: "gray",
};

export default function Suppressions() {
  const toast = useToast();
  const [items, setItems] = useState<Suppression[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [skip, setSkip] = useState(0);
  const TAKE = 200;

  const load = () => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    p.set("take", String(TAKE));
    p.set("skip", String(skip));
    api<{ total: number; items: Suppression[] }>(`/api/suppressions?${p.toString()}`)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => toast.error((e as Error).message));
  };
  useEffect(load, [skip]);
  useEffect(() => {
    const t = setTimeout(() => (skip === 0 ? load() : setSkip(0)), 300);
    return () => clearTimeout(t);
  }, [search]);

  const add = async () => {
    if (!email.trim()) return;
    try {
      await api("/api/suppressions", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      toast.success("Suppressed");
      setEmail("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async (e: string) => {
    if (!confirm(`Remove ${e} from the suppression list? It can be emailed again.`)) return;
    await api(`/api/suppressions/${encodeURIComponent(e)}`, { method: "DELETE" });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Suppression list"
        description="Addresses here are never emailed: unsubscribes, bounces, opt-out replies and manual blocks. Checked before every single send."
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              download("/api/suppressions/export", `suppressions-${Date.now()}.csv`).catch((e) =>
                toast.error((e as Error).message),
              )
            }
          >
            Export CSV
          </Button>
        }
      />
      <Card flush>
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row">
          <form
            className="flex gap-2 md:w-[28rem]"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
            <Button type="submit">Suppress</Button>
          </form>
          <input
            placeholder={`Search ${total} addresses`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input md:ml-auto md:w-72"
          />
        </div>
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title={search ? "No matches" : "Nobody suppressed yet"} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Reason</th>
                  <th>Detail</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.email}>
                    <td>{s.email}</td>
                    <td>
                      <Badge kind={REASON_KIND[s.reason] ?? "gray"}>{s.reason}</Badge>
                    </td>
                    <td className="text-muted">{s.detail ?? ""}</td>
                    <td className="whitespace-nowrap text-muted">{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove(s.email)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-5 pb-4">
          <Pagination total={total} take={TAKE} skip={skip} onPage={setSkip} />
        </div>
      </Card>
    </div>
  );
}
