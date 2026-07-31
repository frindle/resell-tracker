FROM node:22-alpine AS builder
WORKDIR /app

# Native deps (better-sqlite3) need build tools at install time
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build
# Build timestamp — /api/version falls back to comparing this against the
# latest main commit date when BUILD_SHA wasn't passed (e.g. a plain
# `docker-compose build` without update.sh). This layer re-runs on every
# source change because it sits below COPY . .
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > .build-time

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Docker auto-injects HOSTNAME=<container-id> into every container. Next.js
# standalone's generated server.js does `process.env.HOSTNAME || '0.0.0.0'`,
# so without this override it binds only to whatever Docker's internal DNS
# resolves that container-id hostname to (this container's macvlan IP) —
# not loopback. That silently broke every auto-sync loopback call
# (lib/autoSync.ts fetches http://127.0.0.1:$PORT/api/... for CC/BFMR/
# BigSky) with ECONNREFUSED, while the app itself stayed reachable
# externally via its real macvlan IP the whole time. Confirmed live
# 2026-07-31: `docker exec <container> node -e "fetch('http://127.0.0.1:3000/...')"`
# → ECONNREFUSED 127.0.0.1:3000, despite the same port answering fine from
# outside the container.
ENV HOSTNAME=0.0.0.0

# Bake the git commit SHA into the image so /api/version can compare it
# against GitHub main to flag the dashboard as out-of-date.
# Pass via: BUILD_SHA=$(git rev-parse --short HEAD) docker-compose build
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA

# Copy standalone server (bundles most JS deps into node_modules/)
COPY --from=builder /app/.next/standalone ./
# Overwrite with the full builder node_modules so native binaries
# (better-sqlite3, bcryptjs, etc.) are the correctly-compiled versions
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/.build-time ./
COPY --from=builder /app/app/generated ./app/generated

EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node server.js"]
