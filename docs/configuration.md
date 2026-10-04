# Configuration

All configuration is environment variables, read from `.env`. The **Settings** page in the app shows the effective values (never secrets). Change `.env`, then `docker compose up -d` to apply.

On start, both processes validate the configuration and refuse to run with a missing or placeholder secret, printing exactly what to fix.

## Required

| Variable | Description |
|----------|-------------|
| `APP_BASE_URL` | Public URL of the app, without a trailing slash. Used for OAuth redirects and the links inside emails. |
| `SESSION_SECRET` | Random string, 32+ characters. Signs session cookies. Rotating it signs everyone out. |
| `TRACKING_SECRET` | Random string. Signs unsubscribe and tracking links. **Never rotate after sending starts**: links in delivered email would break. |
| `TOKEN_ENCRYPTION_KEY` | Exactly 64 hex characters. Encrypts Gmail OAuth tokens at rest. |
| `ALLOWED_LOGIN_EMAILS` and/or `ADMIN_PASSWORD` | At least one sign-in method. |

`node scripts/init-env.mjs` generates all the secrets. To make one by hand: `openssl rand -hex 32`.

## Sign-in and access

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_LOGIN_EMAILS` | — | Comma-separated addresses allowed to sign in with Google. `@example.com` allows a whole domain. Needs the Google OAuth client. |
| `ADMIN_PASSWORD` | — | Enables password sign-in with this shared password. Use 12+ characters. Attempts are rate-limited to 10 per 15 minutes per IP. |
| `API_TOKEN` | — | Enables `Authorization: Bearer <token>` on every `/api` route, for scripts. Actions are audited as actor `api`. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-For` from a reverse proxy. Set `false` if the app is exposed directly. |

## Google

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | OAuth client (see [google-setup.md](google-setup.md)). Needed to connect inboxes. |
| `GOOGLE_REDIRECT_URI` | `${APP_BASE_URL}/api/accounts/oauth/callback` | Inbox-connect callback. |
| `GOOGLE_LOGIN_REDIRECT_URI` | `${APP_BASE_URL}/api/auth/google/callback` | Sign-in callback. |

## Sending

| Variable | Default | Description |
|----------|---------|-------------|
| `SEND_LIVE` | `false` | `false` is dry-run: everything runs and is recorded, but nothing is emailed. |
| `GLOBAL_DAILY_CAP` | `100` | Maximum cold emails per day across all inboxes. |
| `PER_INBOX_TOTAL_CAP` | `40` | Safe total per inbox per day, warmup plus cold. Each inbox's cold cap fits inside what's left after its warmup volume. |
| `HOLIDAY_CALENDAR` | `us` | `us` skips US federal holidays (observed dates). `none` disables holiday skipping. |
| `DEFAULT_TIMEZONE` | `America/Los_Angeles` | Timezone for imported leads with no timezone column, region or recognizable US state. |

Per-inbox settings (cold cap, warmup volume, send windows, hourly limit, minimum gap, signature, send-as alias) are edited on the **Inboxes** page.

## Default sender footer

Appended as a plain signature block to every email whose footer is set to *Default*. With all four blank, no footer is added.

| Variable | Example |
|----------|---------|
| `SENDER_NAME` | `Alex Morgan` |
| `SENDER_TITLE` | `Founder` |
| `SENDER_COMPANY` | `Acme Inc` |
| `SENDER_POSTAL_ADDRESS` | `1 Main St, Springfield, IL 62701` |

Rendered as:

```
--
Alex Morgan
Founder, Acme Inc
1 Main St, Springfield, IL 62701
```

## Alerts

Alerts fire when an inbox is quarantined or auto-paused, its health drops, a send fails permanently, or a campaign's reply rate is persistently under 1%. They always appear in the activity log; optionally also:

| Variable | Description |
|----------|-------------|
| `ALERT_CHANNEL` | `none`, `email`, `telegram` or `webhook` |
| `ALERT_EMAIL` | `email`: recipient. Sent from your first connected inbox, even in dry-run. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `telegram` |
| `ALERT_WEBHOOK_URL` | `webhook`: Slack or Discord incoming webhook, or any endpoint that accepts `POST` JSON `{ text, content, title, detail }`. |

## Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL URL. Compose sets this automatically. |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL. Compose sets this automatically. |
| `POSTGRES_PASSWORD` | `trickle` | Password for the bundled Postgres container. |
| `PORT` | `8080` | Port the app listens on inside the container. |
| `HOST_PORT` / `BIND_ADDRESS` | `8080` / `127.0.0.1` | Where Compose publishes the app on the host. |
| `DOMAIN` | — | Hostname for the bundled Caddy (`--profile https`). |
| `TRICKLE_IMAGE` | `trickle:local` | Use a published image instead of building. |

## Importing leads

Headers are matched case-insensitively:

| Field | Accepted headers |
|-------|------------------|
| email (required) | `email`, `email address`, `e-mail`, `mail` |
| name | `name`, `full name`, `contact`, `contact name`, or `first name` + `last name` |
| company | `company`, `company name`, `organization`, `business`, `account` |
| title | `title`, `job title`, `role`, `position` |
| city / state / zip | `city`, `town` / `state`, `province` / `zip`, `postal code`, `postcode` |
| timezone | `timezone`, `time zone`, `tz` (IANA name, e.g. `Europe/Berlin`) |

Every other column is stored as a custom field (up to 30 per lead) and can be used in templates by its header: a column `Company Size` becomes `{{Company Size}}` (also `{{companysize}}` or `{{company_size}}`).

A lead's timezone is chosen in this order: the timezone picked for the whole import, the chosen region's timezone, the row's own timezone column, a region whose state codes match the row, the US state/zip lookup, then `DEFAULT_TIMEZONE`.
