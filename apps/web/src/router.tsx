import { useEffect, useState } from "react";

/**
 * Minimal hash-based router (no dependency). Routes look like:
 *   #/campaigns
 *   #/leads/<id>
 * so refresh and deep-links work.
 */
export interface Route {
  path: string; // e.g. "/leads/abc123"
  segments: string[]; // e.g. ["leads", "abc123"]
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/dashboard";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const segments = path.split("/").filter(Boolean);
  return { path, segments };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse());
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path.startsWith("/") ? path : `/${path}`;
}
