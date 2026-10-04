export async function api<T = any>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects "application/json with empty body" (e.g. DELETE) as a 400.
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> ?? {}) };
  if (opts.body != null) headers["content-type"] = "application/json";

  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: "same-origin",
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as any)?.message ?? (detail as any)?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Trigger a browser download of a CSV (or other file) endpoint. */
export async function download(path: string, filename: string) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Both fields must be appended before the file — the server reads them off
// the multipart stream as it reaches the file part, so anything appended after
// it is invisible.
export async function uploadLeads(file: File, regionId?: string, timezone?: string) {
  const fd = new FormData();
  if (regionId) fd.append("regionId", regionId);
  if (timezone) fd.append("timezone", timezone);
  fd.append("file", file);
  const res = await fetch("/api/leads/import", {
    method: "POST",
    body: fd,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? "import failed");
  }
  return res.json();
}
