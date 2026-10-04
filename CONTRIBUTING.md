# Contributing

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Setup

```bash
pnpm install
cp .env.example .env                              # fill in secrets
docker compose -f docker-compose.dev.yml up -d    # Postgres + Redis
pnpm db:generate && pnpm db:deploy
pnpm -r --filter "./packages/*" build
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```

Keep `SEND_LIVE=false` while developing. Dry-run exercises the whole pipeline without emailing anyone.

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
```

- Changes to the sending algorithm belong in `packages/core`, which is pure and deterministic. Add or update tests there; seed the RNG with `seededRng` so they're reproducible.
- Schema changes need a migration: `pnpm db:migrate --name <change>` generates one under `packages/db/prisma/migrations`.
- Keep the defaults conservative. Changes that make Trickle send faster, hide its traffic or weaken opt-out handling won't be merged.

## Project layout

See the Architecture section of the [README](README.md).
