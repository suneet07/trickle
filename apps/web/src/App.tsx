import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import { Button, ErrorState, Spinner, cx } from "./components.js";
import { ToastProvider } from "./toast.js";
import { useRoute } from "./router.js";
import { ConfigContext } from "./config.js";
import type { AppConfig } from "./types.js";
import Dashboard from "./views/Dashboard.js";
import Accounts from "./views/Accounts.js";
import Leads from "./views/Leads.js";
import LeadDetail from "./views/LeadDetail.js";
import Campaigns from "./views/Campaigns.js";
import Inbox from "./views/Inbox.js";
import Suppressions from "./views/Suppressions.js";
import Blocklist from "./views/Blocklist.js";
import Regions from "./views/Regions.js";
import Activity from "./views/Activity.js";
import History from "./views/History.js";
import Queue from "./views/Queue.js";
import DayPlan from "./views/DayPlan.js";
import Settings from "./views/Settings.js";

type NavItem = { key: string; label: string; icon: React.ReactNode };

/** Minimal inline icons (24px viewBox, stroke = currentColor). */
const I = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "",
    items: [{ key: "dashboard", label: "Dashboard", icon: I("M3 12l9-8 9 8M5 10v10h14V10") }],
  },
  {
    group: "Outreach",
    items: [
      { key: "campaigns", label: "Campaigns", icon: I("M3 11l18-8-8 18-2-8-8-2z") },
      { key: "leads", label: "Leads", icon: I("M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z") },
      { key: "replies", label: "Replies", icon: I("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z") },
    ],
  },
  {
    group: "Sending",
    items: [
      { key: "queue", label: "Queue", icon: I("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01") },
      { key: "dayplan", label: "Day plan", icon: I("M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z") },
      { key: "inboxes", label: "Inboxes", icon: I("M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z") },
    ],
  },
  {
    group: "Lists",
    items: [
      { key: "suppressions", label: "Suppressions", icon: I("M18.36 6.64A9 9 0 1 1 5.64 18.36 9 9 0 0 1 18.36 6.64zM5.64 5.64l12.72 12.72") },
      { key: "blocklist", label: "Domain blocklist", icon: I("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z") },
      { key: "regions", label: "Regions", icon: I("M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z") },
    ],
  },
  {
    group: "Insights",
    items: [
      { key: "history", label: "History", icon: I("M3 3v18h18M7 15l4-4 3 3 5-6") },
      { key: "activity", label: "Activity log", icon: I("M22 12h-4l-3 9L9 3l-3 9H2") },
      { key: "settings", label: "Settings", icon: I("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z") },
    ],
  },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path d="M16 6c-3.6 4.6-6.5 8.4-6.5 11.7a6.5 6.5 0 0 0 13 0C22.5 14.4 19.6 10.6 16 6z" className="fill-accent-fg" />
      </svg>
      Trickle
    </span>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? "system");
  const cycle = () => {
    const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem("trickle.theme");
      else localStorage.setItem("trickle.theme", next);
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };
  return [theme, cycle];
}

function Shell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [probeError, setProbeError] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, cycleTheme] = useTheme();
  const route = useRoute();
  const tab = route.segments[0] ?? "dashboard";

  const probe = () => {
    setProbeError(false);
    api("/api/auth/me")
      .then(() => setAuthed(true))
      .catch((e: unknown) => {
        if ((e as Error)?.message === "unauthorized") setAuthed(false);
        else {
          setAuthed(null);
          setProbeError(true);
        }
      });
  };
  useEffect(probe, []);
  useEffect(() => {
    if (authed) api<AppConfig>("/api/config").then(setConfig).catch(() => {});
  }, [authed]);
  useEffect(() => setMenuOpen(false), [route.path]);

  if (probeError)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <ErrorState message="Can't reach the server." onRetry={probe} />
      </div>
    );
  if (authed === null) return <Spinner />;
  if (!authed) return <Login onIn={() => setAuthed(true)} />;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setAuthed(false);
  };

  const nav = (
    <nav className="flex flex-col gap-5 px-3 py-4">
      {NAV.map((g) => (
        <div key={g.group || "top"}>
          {g.group && (
            <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted/80">
              {g.group}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {g.items.map((it) => {
              const active = tab === it.key;
              return (
                <a
                  key={it.key}
                  href={`#/${it.key}`}
                  className={cx(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-muted hover:bg-subtle hover:text-fg",
                  )}
                >
                  {it.icon}
                  {it.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const footer = (
    <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
      <button
        onClick={cycleTheme}
        className="rounded-md px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-fg"
        title="Switch theme"
      >
        Theme: {theme}
      </button>
      <button onClick={logout} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-fg">
        Log out
      </button>
    </div>
  );

  return (
    <ConfigContext.Provider value={config}>
      <div className="min-h-screen lg:pl-60">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface lg:flex">
          <div className="flex h-14 items-center px-5">
            <Logo />
          </div>
          <div className="flex-1 overflow-y-auto">{nav}</div>
          {footer}
        </aside>

        {/* Mobile top bar + drawer */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
          <Logo />
          <Button variant="secondary" size="sm" onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? "Close" : "Menu"}
          </Button>
        </header>
        {menuOpen && (
          <div className="fixed inset-0 top-14 z-20 flex flex-col overflow-y-auto bg-surface lg:hidden">
            <div className="flex-1">{nav}</div>
            {footer}
          </div>
        )}

        {config && !config.sendLive && (
          <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-xs text-fg sm:px-8">
            <strong className="font-semibold">Dry-run mode.</strong> The full pipeline runs, but no email is
            actually sent. Set <code className="kbd">SEND_LIVE=true</code> when you are ready.
          </div>
        )}

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-8 sm:py-8">
          <Router tab={tab} route={route} />
        </main>
      </div>
    </ConfigContext.Provider>
  );
}

function Router({ tab, route }: { tab: string; route: ReturnType<typeof useRoute> }) {
  switch (tab) {
    case "dashboard":
      return <Dashboard />;
    case "campaigns":
      return <Campaigns />;
    case "leads":
      return route.segments[1] ? <LeadDetail id={route.segments[1]} /> : <Leads />;
    case "inboxes":
      return <Accounts />;
    case "replies":
      return <Inbox />;
    case "suppressions":
      return <Suppressions />;
    case "blocklist":
      return <Blocklist />;
    case "regions":
      return <Regions />;
    case "queue":
      return <Queue />;
    case "dayplan":
      return <DayPlan />;
    case "history":
      return <History />;
    case "activity":
      return <Activity />;
    case "settings":
      return <Settings />;
    default:
      return <Dashboard />;
  }
}

const AUTH_ERRORS: Record<string, string> = {
  not_allowed: "That Google account isn't on the allowed list (ALLOWED_LOGIN_EMAILS).",
  state: "Sign-in expired. Please try again.",
  verify: "Couldn't verify your Google sign-in.",
  cancelled: "Sign-in was cancelled.",
  google_disabled: "Google sign-in isn't configured on this server.",
};

function Login({ onIn }: { onIn: () => void }) {
  // Google redirects back to "/?auth_error=..." on any failure; surface it.
  const params = new URLSearchParams(window.location.search);
  const errKey = params.get("auth_error");
  const [err, setErr] = useState(errKey ? (AUTH_ERRORS[errKey] ?? "Sign-in failed.") : "");
  const [methods, setMethods] = useState<{ google: boolean; password: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ google: boolean; password: boolean }>("/api/auth/methods")
      .then(setMethods)
      .catch(() => setMethods({ google: true, password: false }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ password }) });
      window.history.replaceState(null, "", "/");
      onIn();
    } catch (ex) {
      setErr((ex as Error).message === "unauthorized" ? "Wrong password." : (ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo className="text-xl" />
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <h1 className="text-base font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Self-hosted cold email that lands in the inbox.</p>
          {err && <div className="mt-4 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{err}</div>}

          {!methods ? (
            <Spinner />
          ) : (
            <div className="mt-5 space-y-4">
              {methods.google && (
                <a
                  href="/api/auth/google/start"
                  className="flex w-full items-center justify-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-subtle"
                >
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  </svg>
                  Continue with Google
                </a>
              )}
              {methods.google && methods.password && (
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {methods.password && (
                <form onSubmit={submit} className="space-y-3">
                  <input
                    type="password"
                    className="input"
                    placeholder="Admin password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus={!methods.google}
                  />
                  <Button type="submit" disabled={busy || !password} className="w-full">
                    {busy ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              )}
              {!methods.google && !methods.password && (
                <p className="text-sm text-muted">
                  No sign-in method is configured. Set <code className="kbd">ADMIN_PASSWORD</code> or{" "}
                  <code className="kbd">ALLOWED_LOGIN_EMAILS</code> in your <code className="kbd">.env</code>.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
