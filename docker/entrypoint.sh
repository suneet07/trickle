#!/bin/sh
set -e

migrate() {
  echo "[trickle] applying database migrations"
  cd /app/packages/db
  ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
  cd /app
}

case "${1:-api}" in
  api)
    migrate
    exec node apps/api/dist/server.js
    ;;
  worker)
    export TRICKLE_ROLE=worker
    exec node apps/worker/dist/index.js
    ;;
  migrate)
    migrate
    ;;
  *)
    exec "$@"
    ;;
esac
