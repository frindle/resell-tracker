#!/bin/bash
# Wrapper for the sidecar's two long-running Node processes:
#   poll.js       -- the ExtensionCommand poll loop + the :6081 VNC-password
#                    refresh listener
#   loginQueue.js -- keeps a real Chrome window parked on whichever site needs
#                    a login, on the shared Xvfb display
#
# Usage: start-sidecar.sh <poll|loginQueue>
set -euo pipefail

SCRIPT="${1:?usage: start-sidecar.sh <poll|loginQueue>}"
TAG="sidecar-${SCRIPT}"
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
TRACKER_URL="${TRACKER_URL:-$(app_url)}"

cd /opt/sidecar
mkdir -p "${DATA_DIR:-/data}/sessions" "${DATA_DIR:-/data}/debug"

# Both launch Chrome, so both need the display. Both talk to the app over
# HTTP, so both want it answering -- but neither is fatal if it isn't: they
# have their own per-request error handling and loop forever, and blocking
# the poll loop on the app would just move the failure.
wait_for_x ":${DISPLAY_NUM}" "${X_WAIT_TIMEOUT:-120}" || exit 1
wait_for_http "${TRACKER_URL}/api/sidecar/info" "${APP_WAIT_TIMEOUT:-180}" || \
  log "app not answering yet — starting anyway, ${SCRIPT}.js retries on its own schedule"

log "node src/${SCRIPT}.js"
exec node "src/${SCRIPT}.js"
