#!/bin/bash
# NumLock watcher for x11vnc sessions.  With -xkb, a client's Caps Lock can
# reset the server-side lock; this daemon re-enables it silently every few
# seconds so noVNC numpad keys emit digits instead of navigation codes.
set -u

PIDFILE="${NUMLOCK_PIDFILE:-/tmp/numlock-watch.pid}"

# --- single-instance guard -------------------------------------------------
if [ -f "$PIDFILE" ]; then
  existing=$(cat "$PIDFILE")
  if kill -0 "$existing" 2>/dev/null; then
    # Another watcher is already running — nothing to do.
    exit 0
  fi
fi
echo $$ > "$PIDFILE"

cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT TERM INT HUP

# --- helpers -----------------------------------------------------------------
state() {
  DISPLAY="${DISPLAY:-:${DISPLAY_NUM:-99}}" \
    xset q | sed -n 's/.*Num Lock:[[:space:]]*\([a-z]*\).*/\1/p' | head -c4
}

# --- main loop ---------------------------------------------------------------
initial="$(state)"
printf '[x11vnc] numlock initial state: %s\n' "$initial"

while true; do
  s="$(state)"
  if [ "$s" = "off" ]; then
    DISPLAY="${DISPLAY:-:${DISPLAY_NUM:-99}}" numlockx on >/dev/null 2>&1 || true
    printf '[x11vnc] numlock was off, re-enabled\n'
  fi
  sleep "${NUMLOCK_POLL_SECS:-3}" & wait $!   # interruptible sleep
done
