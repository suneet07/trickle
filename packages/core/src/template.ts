import { Rng } from "./util.js";

/**
 * Merge variables + spintax rendering.
 *  - {{firstName}}, {{company}}, {{city}}, {{title}}, {{state}} ...
 *  - {Hi|Hello|Hey} spintax randomization
 *  - any extra column imported with the lead (custom fields) as {{columnName}}
 */

export interface MergeVars {
  firstName?: string;
  lastName?: string;
  name?: string;
  company?: string;
  city?: string;
  state?: string;
  title?: string;
  email?: string;
  [k: string]: string | undefined;
}

function firstNameOf(vars: MergeVars): string {
  if (vars.firstName) return vars.firstName;
  if (vars.name) return vars.name.trim().split(/\s+/)[0] ?? "";
  return "";
}

/** Normalize a placeholder key for lookup: lowercase, strip spaces/underscores/
 * hyphens, so {{first_name}}, {{First-Name}}, {{first name}} all resolve the
 * same as {{firstName}}. Prevents silent blanking from case/alias mismatches. */
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[\s_-]/g, "");
}

/** Resolve {{var}} placeholders. Unknown/empty vars render as empty string. */
export function renderMergeVars(tpl: string, vars: MergeVars): string {
  const derived: MergeVars = { ...vars, firstName: firstNameOf(vars) };
  const byNormalizedKey = new Map<string, string>();
  for (const [k, v] of Object.entries(derived)) {
    if (v != null) byNormalizedKey.set(normalizeKey(k), String(v));
  }
  return tpl.replace(/\{\{\s*(\w[\w\s-]*?)\s*\}\}/g, (_m, key: string) => {
    return byNormalizedKey.get(normalizeKey(key)) ?? "";
  });
}

/** Resolve {a|b|c} spintax, recursively, using injected rng for reproducibility. */
export function renderSpintax(tpl: string, rng: Rng = Math.random): string {
  const re = /\{([^{}]*)\}/;
  let out = tpl;
  let guard = 0;
  while (re.test(out) && guard++ < 1000) {
    out = out.replace(re, (_m, inner: string) => {
      const options = inner.split("|");
      return options[Math.floor(rng() * options.length)] ?? "";
    });
  }
  return out;
}

/**
 * Full render: merge vars first (so {{firstName}} is resolved before the
 * spintax pass, which would otherwise consume the inner brace pair), then
 * spintax randomization.
 */
export function renderTemplate(
  tpl: string,
  vars: MergeVars,
  rng: Rng = Math.random,
): string {
  return renderSpintax(renderMergeVars(tpl, vars), rng);
}

/** Title-case a single word/short phrase (e.g. "founder" -> "Founder"). */
function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Who the email is from, for the default signature-style footer. */
export interface SenderIdentity {
  senderName: string;
  company: string;
  title?: string;
  // Physical postal address. Several anti-spam laws (e.g. CAN-SPAM) require
  // one in commercial email; it is appended as its own line when set.
  postalAddress?: string;
}

/** The footer's lines: name, then "Title, Company", then the address. */
function footerLines(s: SenderIdentity): string[] {
  const name = s.senderName.trim();
  const company = s.company.trim();
  const title = s.title?.trim() ?? "";
  const address = s.postalAddress?.trim() ?? "";
  const line2 = title && company ? `${capitalize(title)}, ${company}` : company || capitalize(title);
  return [name, line2, address].filter(Boolean);
}

/**
 * Default sender footer: a plain signature block ("--", name, title/company,
 * optional postal address). Deliberately no visible unsubscribe link, so the
 * email reads person-to-person; opt-out is handled by the optional
 * List-Unsubscribe header and by detecting "unsubscribe / stop" replies.
 * With no identity configured at all, the body is returned unchanged.
 */
export function withSenderFooter(body: string, sender: SenderIdentity): string {
  const lines = footerLines(sender);
  if (lines.length === 0) return body;
  return body + "\n" + "\n\n--\n" + lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** HTML variant of withSenderFooter for HTML campaigns. */
export function withSenderFooterHtml(bodyHtml: string, sender: SenderIdentity): string {
  const lines = footerLines(sender);
  if (lines.length === 0) return bodyHtml;
  const footer =
    `<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">` +
    `<div style="font-size:12px;color:#888">` +
    lines.map(escapeHtml).join("<br>") +
    `</div>`;
  return `${bodyHtml}\n${footer}`;
}

/**
 * Compose the final body exactly as it is sent: rendered body, then the
 * sending inbox's signature, then the footer. The footer override follows one
 * convention everywhere: null = default sender footer, "" = no footer, any
 * other text = a custom footer appended verbatim.
 *
 * The send job, the live preview and the placement test all call this, so what
 * you preview is what the recipient gets.
 */
export function composeBody(opts: {
  body: string;
  isHtml: boolean;
  signature?: string | null;
  footerOverride?: string | null;
  sender: SenderIdentity;
}): string {
  let content = opts.body;
  if (opts.signature) {
    content += opts.isHtml
      ? `<br><br>${opts.signature.replace(/\n/g, "<br>")}`
      : `\n\n${opts.signature}`;
  }
  const override = opts.footerOverride ?? null;
  if (override == null) {
    return opts.isHtml
      ? withSenderFooterHtml(content, opts.sender)
      : withSenderFooter(content, opts.sender);
  }
  const custom = override.trim();
  if (!custom) return content;
  return opts.isHtml
    ? `${content}\n<br><br>${custom.replace(/\n/g, "<br>")}`
    : `${content}\n\n${custom}`;
}

/** Merge variables available for a lead: its fixed fields plus custom fields. */
export function leadMergeVars(lead: {
  name?: string | null;
  email: string;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  state?: string | null;
  customFields?: unknown;
}): MergeVars {
  const vars: MergeVars = {};
  // Custom fields go in first so a column that collides with a built-in field
  // (e.g. a second "company" column) can never shadow the lead's own value.
  const custom = lead.customFields;
  if (custom && typeof custom === "object" && !Array.isArray(custom)) {
    for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
      if (v != null && v !== "") vars[k] = String(v);
    }
  }
  vars.name = lead.name ?? undefined;
  vars.company = lead.company ?? undefined;
  vars.city = lead.city ?? undefined;
  vars.state = lead.state ?? undefined;
  vars.title = lead.title ?? undefined;
  vars.email = lead.email;
  return vars;
}
