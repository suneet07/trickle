# Deployment

Trickle runs as four containers: the app (web UI + API), the worker, PostgreSQL and Redis. One image serves both app and worker. Everything below uses the `docker-compose.yml` at the repository root.

- [Local machine](#local-machine)
- [VPS with automatic HTTPS](#vps-with-automatic-https)
- [Behind your own reverse proxy](#behind-your-own-reverse-proxy)
- [Using a published image](#using-a-published-image)
- [Upgrades](#upgrades)
- [Backups](#backups)
- [Health checks and logs](#health-checks-and-logs)

## Local machine

```bash
node scripts/init-env.mjs     # creates .env with secrets and an admin password
# add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to .env
docker compose up -d
```

The app listens on `http://localhost:8080`, bound to localhost only. Sends happen only while the containers run, so a laptop that sleeps will skip slots (missed slots are re-planned, never burst-sent).

## VPS with automatic HTTPS

Any Linux server with Docker works; 1 vCPU and 1 GB RAM is plenty.

1. Point a DNS record (e.g. `trickle.example.com`) at the server and open ports 80 and 443.
2. Clone the repository on the server and create `.env`:

   ```bash
   node scripts/init-env.mjs
   ```

   Then set at least:

   ```env
   APP_BASE_URL=https://trickle.example.com
   DOMAIN=trickle.example.com
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

3. Add the production redirect URIs to your Google OAuth client (see [google-setup.md](google-setup.md)).
4. Start with the `https` profile, which adds Caddy and obtains a Let's Encrypt certificate:

   ```bash
   docker compose --profile https up -d
   ```

No Node.js is needed on the server if you use a [published image](#using-a-published-image); otherwise the image is built on first start.

## Behind your own reverse proxy

If the server already runs nginx, Traefik, a Cloudflare Tunnel or similar, skip the `https` profile and proxy to `127.0.0.1:8080`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep `TRUST_PROXY=true` (the default) so rate limiting sees real client IPs. If the proxy runs in another container, set `BIND_ADDRESS=0.0.0.0` and attach both to a shared network instead.

The public paths `/u/*` (unsubscribe), `/o/*` (open pixel) and `/c/*` (click redirect) must stay reachable without authentication, because recipients open them from their email. Don't put them behind an SSO gateway.

## Using a published image

The repository's release workflow publishes `ghcr.io/<owner>/trickle` on every version tag. To use it instead of building locally:

```env
TRICKLE_IMAGE=ghcr.io/<owner>/trickle:latest
```

```bash
docker compose pull
docker compose up -d
```

## Upgrades

```bash
git pull                 # or bump TRICKLE_IMAGE
docker compose up -d --build
```

Database migrations run automatically when the app container starts. The worker waits for the app to be healthy, so it never runs against an old schema.

## Backups

PostgreSQL holds everything that matters (leads, campaigns, history, encrypted tokens). Redis holds only the job queue and can be rebuilt by the planner.

```bash
# Backup
docker compose exec -T postgres pg_dump -U trickle trickle | gzip > trickle-$(date +%F).sql.gz

# Restore into a fresh stack
gunzip -c trickle-2026-01-01.sql.gz | docker compose exec -T postgres psql -U trickle trickle
```

Back up `.env` too, somewhere safe. Without `TOKEN_ENCRYPTION_KEY` the stored Gmail tokens can't be decrypted (inboxes would have to be reconnected), and without `TRACKING_SECRET` unsubscribe links in already-sent email stop working.

## Health checks and logs

- `GET /healthz` returns `{ ok: true, workerStale: false }`. `workerStale` turns true when the worker hasn't written a heartbeat for 15 minutes.
- `docker compose logs -f app worker` shows both processes. Every alert is also written to **Activity log** in the UI.
- `docker compose ps` shows container health.
