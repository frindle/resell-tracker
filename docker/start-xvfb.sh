#!/bin/bash
# Virtual framebuffer. Every Playwright launch in this container runs headed
# (headless:false) against this display, both the one-time interactive login
# and the unattended poll-loop runs -- headless launch flags trigger more
# Amazon/Walmart bot detection than a genuine headed browser on a virtual
# display.
set -euo pipefail

TAG=xvfb
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
GEOMETRY="${XVFB_GEOMETRY:-1280x900x24}"

# Runs on EVERY start, not just the first: supervisord can restart Xvfb
# in-place after a crash, and a crashed Xvfb is exactly what leaves the lock
# behind. See clear_stale_x_locks() in lib.sh for the full history.
clear_stale_x_locks "$DISPLAY_NUM"

log "Xvfb :${DISPLAY_NUM} ${GEOMETRY}"
exec Xvfb ":${DISPLAY_NUM}" -screen 0 "$GEOMETRY" -nolisten tcp
