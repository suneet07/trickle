<p align="center">
  <img src="apps/web/public/favicon.svg" width="56" height="56" alt="" />
</p>

<h1 align="center">Trickle</h1>

<p align="center">
  <strong>Self-hosted cold email that lands in the inbox.</strong><br />
  Human-paced drip sending across your own Gmail inboxes, with warmup, health monitoring and reply tracking built in.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-the-sending-algorithm-works">How it works</a> ·
  <a href="docs/google-setup.md">Google setup</a> ·
  <a href="docs/deployment.md">Deployment</a> ·
  <a href="docs/configuration.md">Configuration</a>
</p>

---

Most cold email tools blast a list as fast as they're allowed to. Mailbox providers notice: identical timing, round-number intervals, bursts at the top of the hour, too many emails to one company at once. Trickle does the opposite. It spreads every send across each recipient's own working hours with randomized, human-looking gaps, keeps every inbox under a safe daily volume, and backs off automatically the moment bounces or errors suggest something is wrong.

It runs on your own server or laptop as a Docker Compose stack. Your leads, inboxes and tokens never leave your machine.

## Features

**Deliverability-first sending**
- **Drip planner.** Each night (and right after you launch) it plans the next business day: follow-ups first, then new leads, slotted into weighted send windows in the *recipient's* timezone.
- **Human pacing.** Log-normal gaps between sends, second-level jitter, random "coffee breaks", inboxes staggered so no two send within 90 seconds, never more than one email to the same company domain per inbox per 24 hours.
- **Safe daily caps.** Per-inbox cold cap, a global ceiling, warmup volume reserved first, and a ramp for new inboxes (30% → 50% → 75% → 100% over three weeks).
- **Health score and circuit breakers.** A 0–100 score per inbox from bounces, send errors, DNSBL listings and SPF/DMARC. Low health throttles the cap; very low health quarantines the inbox. Two hard bounces in a day pause an inbox for 48 hours.
- **Built-in warmup.** Peer-to-peer warmup between your inboxes, with spam rescue on the receiving side.
- **Inbox placement test.** Sends the real rendered email between your inboxes and reports inbox / spam / promotions before you launch.

**Campaigns**
- Multi-step sequences sent in the same thread, auto-canceled on reply, bounce or unsubscribe.
- `{{merge}}` fields, including any custom column from your CSV, and `{Hi|Hello}` spintax.
- A/B testing with per-variant reply rates.
- Live preview against real leads, showing exactly what will be sent (signature and footer included).
- Filters by city and timezone, scheduled starts, plain text or HTML, optional open/click tracking.

**Replies and compliance**
- Reply detection every 10 minutes; out-of-office and auto-replies are ignored.
- Unified reply inbox, with replies sent in-thread from the app.
- "Unsubscribe / stop / remove me" replies are suppressed automatically.
- Global suppression list (checked before every single send), domain blocklist, signed one-click `List-Unsubscribe` links (RFC 8058).
- Audit log of every state-changing action.

**Operations**
- Dry-run mode: the whole pipeline runs and records sends without emailing anyone.
- Editable send queue: reschedule, move to another inbox, or hold any email.
- Per-inbox day plan, sending history, activity log.
- Alerts to email, Telegram, Slack, Discord or any webhook.
- REST API with an optional bearer token for automation.

## Quick start

You need Docker (with Compose) and a Google Cloud OAuth client. The OAuth client takes about five minutes; see [docs/google-setup.md](docs/google-setup.md).

```bash
git clone https://github.com/<you>/trickle.git
cd trickle

# Create .env with fresh random secrets and an admin password (printed once).
node scripts/init-env.mjs        # or: cp .env.example .env, then fill it in

# Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then:
docker compose up -d
```

Open <http://localhost:8080>, sign in with the admin password, and follow the checklist on the dashboard:

1. **Inboxes → Connect Gmail** for each inbox you want to send from.
2. **Leads → Import** a CSV or XLSX. An `email` column is all that's required.
3. **Campaigns → New campaign**: write the sequence, check the preview, run a placement test, launch.
4. Watch a day of dry-run sends in **Queue** and **Day plan**, then set `SEND_LIVE=true` in `.env` and run `docker compose up -d` again.

To put it on a public server with HTTPS, set `DOMAIN` and `APP_BASE_URL` in `.env` and run `docker compose --profile https up -d`. See [docs/deployment.md](docs/deployment.md).

## How the sending algorithm works

Every night at 00:05 UTC, and right after a campaign is launched or resumed, the planner builds the next plan:

1. **Budget.** Each inbox gets a daily cold cap:

   ```
   cap = min(base cap, total cap − warmup volume) × health multiplier × ramp factor
   ```

   then minus whatever it already sent or has queued today, so re-planning only ever tops up. The sum across inboxes is limited by the global ceiling.

   | Health score | Multiplier |   | Inbox age  | Ramp factor |
   |--------------|-----------:|---|------------|------------:|
   | 90–100       | 1.0        |   | days 1–7   | 0.3         |
   | 70–89        | 0.6        |   | days 8–14  | 0.5         |
   | 50–69        | 0.3        |   | days 15–21 | 0.75        |
   | under 50     | 0 (quarantined) | | day 22+ (or marked warmed) | 1.0 |

2. **Selection.** Due follow-ups go first, then pending leads from running campaigns. Suppressed addresses, blocklisted domains and snoozed leads are skipped. Each lead sticks to one sending inbox (new leads are assigned round-robin), so a whole conversation comes from the same address.

3. **Slotting.** For each inbox, leads are grouped by timezone and placed into send windows in the recipient's local time (default 08:30–11:30, 13:00–16:30 and 16:30–18:00, weighted 50 / 35 / 15). Weekdays are weighted too (Tuesday–Thursday heaviest, weekends off) and US federal holidays are skipped unless you set `HOLIDAY_CALENDAR=none`. Gaps between sends are drawn from a log-normal distribution scaled to fill the window evenly, with jitter and occasional longer pauses. Leads that don't fit (cap reached, same company domain already emailed today, window full) are carried to the next day, and the reasons are recorded.

4. **Sending.** Each slot becomes a delayed job. At send time the worker re-checks everything (inbox paused? campaign paused? lead suppressed or already replied?) before anything goes out. Rate-limit errors from Gmail retry with exponential backoff; other failures are recorded and alerted.

Every rule above is pure, deterministic code in [`packages/core`](packages/core) with unit tests.

## Architecture

```
apps/
  api/      Fastify REST API; also serves the built web app
  worker/   BullMQ jobs: planner, sender, reply poller, health check, warmup, placement test
  web/      React + Vite + Tailwind single-page app
packages/
  core/     The sending algorithm (caps, health, slots, planner, templates). Pure + tested
  db/       Prisma schema, migrations, encrypted-token helpers
  shared/   Config, Gmail client, queues, alerts, DNS checks, signed links
```

PostgreSQL stores everything; Redis only holds the job queue (an hourly reconcile job recovers if it's ever lost). The Docker image contains both the API and the worker; Compose runs it twice.

## Development

Requires Node 22+ and pnpm 9.

```bash
pnpm install
cp .env.example .env                              # fill in secrets + Google OAuth
docker compose -f docker-compose.dev.yml up -d    # Postgres + Redis only
pnpm db:generate && pnpm db:deploy
pnpm -r --filter "./packages/*" build

pnpm dev:api      # http://localhost:8080
pnpm dev:worker
pnpm dev:web      # http://localhost:5173, proxies /api to :8080
```

Tests and type checks:

```bash
pnpm test
pnpm typecheck
```

## Responsible use

Trickle is built to send *wanted* outreach at low volume, the way a person would. It is not a bulk mailer and it will not help you get past spam filters with unwanted mail. You are responsible for complying with the laws that apply to you and your recipients (for example CAN-SPAM in the US, GDPR and PECR in the EU and UK, CASL in Canada) and with Google's terms and sender guidelines. In practice:

- Email people with a plausible, legitimate reason to hear from you.
- Identify yourself honestly and include a postal address where required (`SENDER_POSTAL_ADDRESS`).
- Honour every opt-out immediately. Trickle suppresses unsubscribes and opt-out replies automatically; don't remove them from the suppression list.
- Keep volumes modest. The defaults are conservative on purpose.

## License

[MIT](LICENSE)
