#!/bin/bash
# Next.js standalone server. Same two steps the old ./Dockerfile CMD ran:
#   node_modules/.bin/prisma migrate deploy && node server.js
# Split out here so a migration failure is a clean non-zero exit that
# supervisord can retry (and eventually escalate to FATAL) rather than a
# silently half-started container.
set -euo pipefail

TAG=app
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

cd /app

log "prisma migrate deploy"
node_modules/.bin/prisma migrate deploy

log "starting Next.js on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node server.js
