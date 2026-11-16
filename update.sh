#!/usr/bin/env bash
# One-shot update for the resell-tracker container.
# Pulls main, builds with the current commit SHA baked in (so the NavBar
# update-available badge can compare against GitHub), and restarts.
#
# Usage:  ./update.sh
#         ./update.sh --force       # build even if nothing in the image changed
#
# The image is rebuilt only when a file that goes into it changed since the
# last successful build. `docker-compose up -d` always runs, so .env edits are
# still picked up.

set -e

cd "$(dirname "$0")"

FORCE_BUILD=""
case "${1:-}" in
  --force) FORCE_BUILD="--force" ;;
esac

# --- build only what changed -------------------------------------------------
# $BUILD_MARKER holds the commit the image was last built from. It is
# gitignored, so `git reset --hard` leaves it alone. It is written only after a
# build succeeded; a skipped run leaves it, so the next diff still starts at the
# last real build.
BUILD_MARKER=.last-built-sha

# is_build_input <path>: succeeds when a change to <path> can change the image.
# Dockerfile.all-in-one does `COPY . .` into the builder and copies docker/,
# sidecar/ and giftcard-ocr/ into the runtime, so everything counts as an input
# except the files below, which never reach the running image. Unknown paths
# build. Keep in step with lib/buildInputs.ts (the "update available" badge).
is_build_input() {
  case "$1" in
    # Always inputs, and runtime directories (a *.md or test there still ships).
    Dockerfile|Dockerfile.all-in-one|docker-compose.yml|.dockerignore|package.json|package-lock.json) return 0 ;;
    public/*|docker/*|sidecar/*|giftcard-ocr/*|prisma/*) return 0 ;;
    # Never in the image.
    *.md|.github/*|workers/*|update.sh|tests/*|.gitignore|.gitattributes) return 1 ;;
    *.test.ts|*.test.tsx|*.test.js|*.test.mjs) return 1 ;;
  esac
  return 0
}

# decide_build: sets DO_BUILD (1 or 0) and BUILD_WHY. When in doubt: build.
decide_build() {
  DO_BUILD=1
  local new old changed f n=0
  new="$(git rev-parse HEAD)"
  old=""
  if [ -r "$BUILD_MARKER" ]; then old="$(tr -d '[:space:]' < "$BUILD_MARKER" 2>/dev/null || true)"; fi
  if [ -n "$FORCE_BUILD" ]; then BUILD_WHY="$FORCE_BUILD given"; return; fi
  if [ -z "$old" ]; then BUILD_WHY="no build marker yet (first run)"; return; fi
  if ! git cat-file -e "${old}^{commit}" 2>/dev/null; then BUILD_WHY="build marker is not a known commit"; return; fi
  if [ "$old" = "$new" ]; then DO_BUILD=0; BUILD_WHY="no new commits since the last build (${new:0:7})"; return; fi
  if ! changed="$(git diff --relative --no-renames --name-only "$old" "$new" -- 2>/dev/null)"; then
    BUILD_WHY="cannot diff ${old:0:7}..${new:0:7}"; return
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if is_build_input "$f"; then BUILD_WHY="image input changed: $f"; return; fi
    n=$((n + 1))
  done <<< "$changed"
  DO_BUILD=0
  BUILD_WHY="${n} file(s) changed since ${old:0:7}, none of them go into the image"
}

# Hard-reset to origin's main instead of `git pull`: this deploy clone has
# no local commits, and a plain pull fails with "divergent branches" whenever
# upstream history is force-pushed (e.g. a history cleanup). fetch+reset is
# deterministic and always lands exactly on origin/main.
echo "=== fetching + hard reset to origin/main ==="
git fetch origin
git reset --hard origin/main

decide_build
if [ "$DO_BUILD" = 1 ]; then
  export BUILD_SHA="$(git rev-parse --short HEAD)"
  echo "=== building with BUILD_SHA=$BUILD_SHA: $BUILD_WHY ==="
  # Scope build to only the app service to avoid re-downloading large OCR models
  docker-compose build app
  # Reached only when the build succeeded (set -e).
  git rev-parse HEAD > "$BUILD_MARKER"
else
  # The running image still carries the SHA it was built from. Pass that same
  # value so `up -d` does not see a changed build arg and recreate the container.
  export BUILD_SHA="$(git rev-parse --short "$(tr -d '[:space:]' < "$BUILD_MARKER")")"
  echo "=== build skipped: $BUILD_WHY (image stays at BUILD_SHA=$BUILD_SHA) ==="
fi

echo "=== restart ==="
# Bring up the single all-in-one app service and REMOVE ORPHANS: the migration
# to one container dropped the standalone sidecar/giftcard-ocr services from
# compose, so their old containers must be cleaned up or they keep running
# alongside the app (the "3 containers when it should be 1" bug). Only `app` is
# defined now, so an unscoped up is correct.
docker-compose up -d --remove-orphans

echo "=== done ==="
docker-compose ps
