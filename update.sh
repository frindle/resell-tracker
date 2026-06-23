#!/usr/bin/env bash
# One-shot update for the resell-tracker container.
# Pulls main, builds with the current commit SHA baked in (so the NavBar
# update-available badge can compare against GitHub), and restarts.
#
# Usage:  ./update.sh

set -e

cd "$(dirname "$0")"

echo "=== git pull ==="
git pull

export BUILD_SHA="$(git rev-parse --short HEAD)"
echo "=== building with BUILD_SHA=$BUILD_SHA ==="
docker-compose build

echo "=== restart ==="
docker-compose up -d

echo "=== done ==="
docker-compose ps
