import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Card, Callout, PageHeader, Spinner } from "../components.js";
import { useConfig } from "../config.js";

interface DnsResult {
  domain: string;
  spf: boolean;
  dmarc: boolean;
  ok: boolean;
}

function Row({ label, env, children }: { label: string; env?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-3 sm:gap-4">
      <div className="text-sm text-muted">
        {label}
        {env && <div className="mt-0.5 font-mono text-[11px] text-muted/80">{env}</div>}
      </div>
      <div className="text-sm sm:col-span-2">{children}</div>
    </div>
  );
}

const yesNo = (v: boolean, yes = "Enabled", no = "Disabled") => (
  <Badge kind={v ? "green" : "gray"}>{v ? yes : no}</Badge>
);

/**
 * Read-only view of the server configuration. Everything here is set in the
 * environment (.env); change it there and restart the containers.
 */
export default function Settings() {
  const config = useConfig();
  const [dns, setDns] = useState<DnsResult[] | null>(null);

  useEffect(() => {
    api<DnsResult[]>("/api/config/dns").then(setDns).catch(() => setDns([]));
  }, []);

  if (!config) return <Spinner />;
  const s = config.sender;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          <>
            Configuration lives in your <code className="kbd">.env</code> file. Edit it and restart (
            <code className="kbd">docker compose up -d</code>) to apply changes.
          </>
        }
      />

      <Card title="Sending">
        <div className="divide-y divide-line">
          <Row label="Mode" env="SEND_LIVE">
            {config.sendLive ? (
              <Badge kind="green">Live: emails are really sent</Badge>
            ) : (
              <Badge kind="yellow">Dry-run: nothing is emailed</Badge>
            )}
          </Row>
          <Row label="Global daily ceiling" env="GLOBAL_DAILY_CAP">
            {config.globalDailyCap} cold emails / day across all inboxes
          </Row>
          <Row label="Per-inbox safe total" env="PER_INBOX_TOTAL_CAP">
            {config.perInboxTotalCap} emails / inbox / day (warmup + cold combined)
          </Row>
          <Row label="Holiday calendar" env="HOLIDAY_CALENDAR">
            {config.holidayCalendar === "us" ? "US federal holidays are skipped" : "No holidays skipped"}
          </Row>
          <Row label="Default lead timezone" env="DEFAULT_TIMEZONE">
            {config.defaultTimezone}
          </Row>
        </div>
      </Card>

      <Card title="Sender footer" description="Appended to every email whose footer is set to Default.">
        <div className="divide-y divide-line">
          <Row label="Name" env="SENDER_NAME">{s.senderName || <span className="text-muted">not set</span>}</Row>
          <Row label="Title" env="SENDER_TITLE">{s.title || <span className="text-muted">not set</span>}</Row>
          <Row label="Company" env="SENDER_COMPANY">{s.company || <span className="text-muted">not set</span>}</Row>
          <Row label="Postal address" env="SENDER_POSTAL_ADDRESS">
            {s.postalAddress || <span className="text-muted">not set</span>}
          </Row>
        </div>
        {!s.postalAddress && (
          <div className="mt-3">
            <Callout tone="warn">
              Laws such as CAN-SPAM (US) require a physical postal address in commercial email. Set{" "}
              <code className="kbd">SENDER_POSTAL_ADDRESS</code> unless you're sure it doesn't apply to you.
            </Callout>
          </div>
        )}
      </Card>

      <Card title="Domain authentication" description="SPF and DMARC records for each sending domain. DKIM is configured in Google Workspace / Gmail.">
        {!dns ? (
          <Spinner />
        ) : dns.length === 0 ? (
          <p className="text-sm text-muted">No inboxes connected yet.</p>
        ) : (
          <div className="divide-y divide-line">
            {dns.map((d) => (
              <div key={d.domain} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="font-medium">{d.domain}</span>
                <div className="flex gap-1.5">
                  <Badge kind={d.spf ? "green" : "red"}>SPF {d.spf ? "found" : "missing"}</Badge>
                  <Badge kind={d.dmarc ? "green" : "red"}>DMARC {d.dmarc ? "found" : "missing"}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Access & integrations">
        <div className="divide-y divide-line">
          <Row label="Public URL" env="APP_BASE_URL">
            <code className="kbd">{config.appBaseUrl}</code>
          </Row>
          <Row label="Google sign-in" env="ALLOWED_LOGIN_EMAILS">
            {yesNo(config.loginMethods.google)}
          </Row>
          <Row label="Password sign-in" env="ADMIN_PASSWORD">
            {yesNo(config.loginMethods.password)}
          </Row>
          <Row label="Gmail OAuth client" env="GOOGLE_CLIENT_ID">
            {yesNo(config.googleConfigured, "Configured", "Not configured")}
          </Row>
          <Row label="API token" env="API_TOKEN">
            {yesNo(config.apiTokenEnabled)}
            {config.apiTokenEnabled && (
              <div className="mt-1 text-xs text-muted">
                Send <code className="kbd">Authorization: Bearer &lt;token&gt;</code> to any <code className="kbd">/api</code>{" "}
                route.
              </div>
            )}
          </Row>
          <Row label="Alerts" env="ALERT_CHANNEL">
            {config.alertChannel === "none" ? <span className="text-muted">Activity log only</span> : config.alertChannel}
          </Row>
          <Row label="Version">{config.version}</Row>
        </div>
      </Card>
    </div>
  );
}
