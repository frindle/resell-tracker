#!/bin/bash
# Shared helpers for the all-in-one container's supervisord program wrappers.
# Sourced, never executed directly.

# Every wrapper's own chatter goes to stderr with a [name] prefix, because
# supervisord does not prefix program output and `docker logs` on this
# container now interleaves five services. The services themselves already
# self-prefix ([entrypoint], [vnc-refresh], [poll], [giftcard-ocr], ...).
log() { echo "[$TAG] $*" >&2; }

# ---------------------------------------------------------------------------
# Readiness gates.
#
# supervisord's `priority` only controls the ORDER programs are spawned in --
# it does not wait for anything to actually be ready before spawning the next.
# These waits are what really enforce the dependency graph, and they run again
# on every individual restart, so a program that supervisord revives mid-life
# re-waits for its dependencies instead of racing them.
# ---------------------------------------------------------------------------

# wait_for_x <display> <timeout_seconds>
wait_for_x() {
  local display="$1" timeout="${2:-60}" waited=0
  while ! xdpyinfo -display "$display" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      log "X display $display not ready after ${timeout}s — giving up so supervisord restarts us"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ "$waited" -gt 0 ] && log "X display $display ready after ${waited}s"
  return 0
}

# wait_for_tcp <host> <port> <timeout_seconds>
wait_for_tcp() {
  local host="$1" port="$2" timeout="${3:-60}" waited=0
  while ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; do
    if [ "$waited" -ge "$timeout" ]; then
      log "$host:$port never opened after ${timeout}s — giving up so supervisord restarts us"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  exec 3<&- 2>/dev/null || true
  [ "$waited" -gt 0 ] && log "$host:$port open after ${waited}s"
  return 0
}

# wait_for_http <url> <timeout_seconds>
# TCP-open is not enough for Next.js: the port binds before the server is
# actually answering requests.
wait_for_http() {
  local url="$1" timeout="${2:-180}" waited=0
  while ! curl -sf -o /dev/null --max-time 5 "$url"; do
    if [ "$waited" -ge "$timeout" ]; then
      log "$url did not answer within ${timeout}s — continuing anyway (the caller has its own retry)"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  [ "$waited" -gt 0 ] && log "$url answering after ~${waited}s"
  return 0
}

# The app's own loopback base URL. lib/autoSync.ts already assumes the app is
# reachable at 127.0.0.1:$PORT from inside its own container; in the merged
# container the sidecar half now gets to assume the same thing, which is
# strictly more reliable than the macvlan round-trip it used to make.
app_url() { echo "http://127.0.0.1:${PORT:-3000}"; }

# Stale X lock/socket cleanup.
#
# KEEP THIS. `docker restart` (including the automatic restart from
# `restart: unless-stopped`) reuses the same writable container layer rather
# than a fresh one, so /tmp isn't wiped -- a lock file left behind by a killed
# Xvfb blocks the next one from binding display :99 at all ("Server is already
# active for display 99"), which cascades into x11vnc never starting either.
# This was a real, observed bug in the sidecar container and it survives the
# merge unchanged; if anything it is now more likely to bite, because
# supervisord can restart Xvfb mid-container-life without a Docker restart.
clear_stale_x_locks() {
  local n="${1:-99}"
  if [ -e "/tmp/.X${n}-lock" ] || [ -e "/tmp/.X11-unix/X${n}" ]; then
    log "clearing stale X lock/socket for display :${n}"
  fi
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
}
