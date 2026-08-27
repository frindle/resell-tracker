#!/bin/bash
# PID 1 for the all-in-one container (tini sits above it when compose sets
# `init: true`, which it does -- Chrome orphans a lot of grandchildren and
# supervisord should not be the one reaping them).
#
# Everything long-running is supervisord's job. This script only does the
# once-per-container-start work that must happen before ANY program spawns,
# then execs supervisord so signals land where they should.
set -euo pipefail

TAG=entrypoint
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

DISPLAY_NUM="${DISPLAY_NUM:-99}"

mkdir -p "${DATA_DIR:-/data}/sessions" "${DATA_DIR:-/data}/debug" \
         /tmp/.X11-unix /tmp/.vnc /var/log/supervisor
chmod 1777 /tmp/.X11-unix || true

# See lib.sh -- this is the sidecar entrypoint's stale-lock cleanup, preserved
# verbatim in effect. start-xvfb.sh does it again on every Xvfb restart; this
# copy covers the container-start case even if Xvfb is somehow started by hand.
clear_stale_x_locks "$DISPLAY_NUM"

# A passwd file left over from the previous boot would let x11vnc come up
# authenticating against a stale password if the fetch in start-x11vnc.sh
# fails. Same reasoning as the X lock: the writable layer survives a restart.
rm -f /tmp/.vnc/passwd

log "starting supervisord (app + xvfb + x11vnc + websockify + login-queue + poll + giftcard-ocr)"
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
