import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastCtx {
  push: (message: string, kind?: ToastKind) => void;
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used within <ToastProvider>");
  return c;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // Stable identity so effects that depend on the toast API don't re-run.
  const api: ToastCtx = useMemo(
    () => ({
      push,
      success: (m) => push(m, "success"),
      error: (m) => push(m, "error"),
      info: (m) => push(m, "info"),
    }),
    [push],
  );

  const color: Record<ToastKind, string> = {
    success: "border-ok/30",
    error: "border-bad/40",
    info: "border-line",
  };
  const dot: Record<ToastKind, string> = {
    success: "bg-ok",
    error: "bg-bad",
    info: "bg-info",
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border bg-surface px-4 py-3 text-sm text-fg shadow-pop ${color[t.kind]}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[t.kind]}`} />
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
