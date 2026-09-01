#!/usr/bin/env bash
# One-shot update for the resell-tracker container.
# Pulls main, builds with the current commit SHA baked in (so the NavBar
# update-available badge can compare against GitHub), and restarts.
#
# Usage:  ./update.sh

set -e

cd "$(dirname "$0")"

# Hard-reset to origin's main instead of `git pull`: this deploy clone has
# no local commits, and a plain pull fails with "divergent branches" whenever
# upstream history is force-pushed (e.g. a history cleanup). fetch+reset is
# deterministic and always lands exactly on origin/main.
echo "=== fetching + hard reset to origin/main ==="
git fetch origin
git reset --hard origin/main

export BUILD_SHA="$(git rev-parse --short HEAD)"
echo "=== building with BUILD_SHA=$BUILD_SHA ==="
# Scope build to only the app service to avoid re-downloading large OCR models
docker-compose build app

echo "=== restart ==="
# Scope restart to only the app service to avoid unnecessary container restarts
docker-compose up -d app

echo "=== done ==="
docker-compose ps
