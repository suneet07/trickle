# syntax=docker/dockerfile:1
#
# One image for the whole app. The same image runs as the web/API server or as
# the background worker, picked by the first argument:
#
#   docker run trickle api      # migrate the database, then serve UI + API
#   docker run trickle worker   # planner, sender, reply polling, health checks
#   docker run trickle migrate  # apply database migrations and exit

FROM node:22-slim AS base
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# 1) Build: full install, generate the Prisma client, build every package.
# ---------------------------------------------------------------------------
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @trickle/db generate \
 && pnpm --filter @trickle/core build \
 && pnpm --filter @trickle/db build \
 && pnpm --filter @trickle/shared build \
 && pnpm --filter @trickle/api build \
 && pnpm --filter @trickle/worker build \
 && pnpm --filter @trickle/web build

# ---------------------------------------------------------------------------
# 2) Production dependencies only, with the Prisma client generated into them.
# ---------------------------------------------------------------------------
FROM base AS proddeps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile
COPY packages/db/prisma packages/db/prisma
RUN pnpm --filter @trickle/db exec prisma generate

# ---------------------------------------------------------------------------
# 3) Runtime: pruned node_modules + built output. Runs as the non-root user.
# ---------------------------------------------------------------------------
FROM base AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=$APP_VERSION PORT=8080
WORKDIR /app
COPY --from=proddeps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/trickle
RUN chmod +x /usr/local/bin/trickle
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["sh", "-c", "[ \"$TRICKLE_ROLE\" = worker ] || node -e \"fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
ENTRYPOINT ["trickle"]
CMD ["api"]
