import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@trickle/db";

/**
 * Per-request actor context. requireAuth calls `actorStorage.enterWith("api")`
 * when the API bearer token authenticates, so every audit() in that request chain
 * is attributable without threading `req` through call sites. Absent = "user".
 */
export const actorStorage = new AsyncLocalStorage<string>();

/** Record a state-changing action in the audit trail (best-effort). */
export async function audit(
  action: string,
  target?: string,
  detail: Record<string, unknown> = {},
) {
  const actor = actorStorage.getStore() ?? "user";
  await prisma.auditLog
    .create({
      data: { action, target: target ?? null, detail: { ...detail, actor } as object },
    })
    .catch(() => {});
}

/** Turn an array of flat objects into a CSV string (RFC 4180-ish). */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return (columns ?? []).join(",") + "\n";
  const cols = columns ?? Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}
