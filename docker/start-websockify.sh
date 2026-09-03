#!/bin/bash
# Browser-based access (noVNC) so connecting doesn't require a native VNC
# client to be installed -- proxies the same authenticated VNC session
# (x11vnc's password prompt still applies) over a plain HTTP/WebSocket port,
# reachable directly since this container has its own macvlan IP.
set -euo pipefail

TAG=websockify
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PORT="${VNC_PORT:-5900}"

# x11vnc's own start-up does a bounded app-readiness wait before it binds, so
# this can legitimately be a couple of minutes behind supervisord's spawn.
wait_for_tcp 127.0.0.1 "$VNC_PORT" "${VNC_WAIT_TIMEOUT:-300}" || exit 1

log "websockify ${NOVNC_PORT} -> localhost:${VNC_PORT} (web root /usr/share/novnc)"
exec websockify --web=/usr/share/novnc "$NOVNC_PORT" "localhost:${VNC_PORT}"
