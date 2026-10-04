import React, { useEffect } from "react";

/** Join class names, skipping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
  flush,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** No inner padding (tables that run edge to edge). */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx("min-w-0 rounded-xl border border-line bg-surface shadow-card", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export type Tone = "green" | "yellow" | "red" | "gray" | "blue";

const TONE: Record<Tone, string> = {
  green: "bg-ok/10 text-ok ring-ok/20",
  yellow: "bg-warn/10 text-warn ring-warn/25",
  red: "bg-bad/10 text-bad ring-bad/20",
  gray: "bg-subtle text-muted ring-line",
  blue: "bg-info/10 text-info ring-info/20",
};

export function Badge({ kind, children }: { kind: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE[kind],
      )}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BTN: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90 shadow-sm",
  secondary: "border border-line bg-surface text-fg hover:bg-subtle shadow-sm",
  ghost: "text-muted hover:bg-subtle hover:text-fg",
  danger: "border border-bad/30 bg-surface text-bad hover:bg-bad/10",
};

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  type = "button",
  disabled,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!disabled && onClick) onClick();
      }}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        disabled && "cursor-not-allowed opacity-50",
        BTN[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Label + control + optional hint, stacked. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Inline checkbox with a label. */
export function Check({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label
      title={title}
      className={cx(
        "inline-flex cursor-pointer select-none items-center gap-2 text-sm text-fg",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        className="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
}) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums", color)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "warn" }) {
  const pct = Math.min(100, (value / Math.max(1, max)) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <div
        className={cx("h-full rounded-full transition-all", tone === "warn" ? "bg-warn" : "bg-accent")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function healthKind(score: number): "green" | "yellow" | "red" {
  if (score >= 90) return "green";
  if (score >= 70) return "yellow";
  return "red";
}

export function Pagination({
  total,
  take,
  skip,
  onPage,
}: {
  total: number;
  take: number;
  skip: number;
  onPage: (skip: number) => void;
}) {
  const page = Math.floor(skip / take) + 1;
  const pages = Math.max(1, Math.ceil(total / take));
  if (total <= take) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
      <span>
        {total} total · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={skip <= 0} onClick={() => onPage(Math.max(0, skip - take))}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(skip + take)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "my-10 w-full rounded-xl border border-line bg-surface shadow-pop",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted hover:bg-subtle hover:text-fg"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-subtle/40 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-sm font-medium text-fg">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="py-10 text-center">
      <div className="mb-3 text-sm text-bad">{message}</div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** A small callout box for warnings and notes. */
export function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "bad" | "ok";
  children: React.ReactNode;
}) {
  const map = {
    info: "border-info/25 bg-info/5 text-fg",
    warn: "border-warn/30 bg-warn/10 text-fg",
    bad: "border-bad/30 bg-bad/5 text-bad",
    ok: "border-ok/30 bg-ok/5 text-fg",
  } as const;
  return <div className={cx("rounded-lg border px-3.5 py-2.5 text-sm", map[tone])}>{children}</div>;
}

/** Local date-time, short form. Null-safe. */
export function fmtDateTime(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(
    undefined,
    opts ?? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  );
}
