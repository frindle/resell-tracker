#!/bin/bash
set -e

mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/debug"

# Virtual framebuffer — every Playwright launch in this container runs
# headed (headless:false) against this display, both the one-time
# interactive login and the unattended poll-loop runs. See Dockerfile
# comment for why (bot-detection research finding).
#
# Clean up a stale lock/socket from a previous crash first: `docker restart`
# (including the automatic restart from `restart: unless-stopped`) reuses
# the same writable container layer rather than a fresh one, so /tmp isn't
# wiped -- a lock file left behind by a killed Xvfb blocks the next one from
# binding display :99 at all ("Server is already active for display 99"),
# which cascades into x11vnc never starting either.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
sleep 1

# VNC so the user can see/drive the one-time interactive login (`docker
# exec -it <container> node src/login.js amazon`). Password-protected —
# unlike the teams-shifts-exporter-docker reference (-nopw), this
# container's browser handles real Amazon/Walmart credentials, so an
# unauthenticated VNC listener on the shared macvlan is a materially
# bigger exposure.
#
# Multi-user: there's one shared X11/VNC session (not one per user), so
# "per-user" here means *who's allowed to connect*, not separate
# sessions. Every user's `vnc_password` Setting (set in the app's
# Settings page) is fetched via GET /api/sidecar/vnc-passwords and
# accepted — x11vnc's -passwdfile accepts any of several stored
# passwords. Falls back to VNC_PASSWORD (or a random one-time password
# printed to the log) if no user has set one yet or the app is
# unreachable at boot.
mkdir -p /tmp/.vnc
rm -f /tmp/.vnc/passwd
PASSWORDS_JSON=""
if [ -n "$SIDECAR_SHARED_SECRET" ] && [ -n "$TRACKER_URL" ]; then
  # `docker-compose up -d` restarts both containers together, and this
  # sidecar's entrypoint runs its one-shot password fetch immediately at
  # boot -- but the app container's Next.js server takes real time to cold
  # start. A single unretried curl attempt here would race that startup
  # window and silently fall back to a random one-time password for this
  # container's entire lifetime (confirmed happening live, 2026-08-21: two
  # consecutive boots both landed on "No VNC passwords configured" right
  # after an update.sh-triggered restart). Retry with backoff instead of a
  # single shot.
  for attempt in 1 2 3 4 5 6; do
    PASSWORDS_JSON=$(curl -sf -H "X-Sidecar-Secret: $SIDECAR_SHARED_SECRET" "$TRACKER_URL/api/sidecar/vnc-passwords" || true)
    if [ -n "$PASSWORDS_JSON" ]; then
      break
    fi
    echo "[entrypoint] vnc-passwords fetch attempt $attempt failed (app likely still starting) — retrying..."
    sleep 5
  done
fi
readarray -t USER_PASSWORDS < <(node -e "
  try {
    const d = JSON.parse(process.argv[1] || '{}');
    (d.passwords || []).forEach(p => console.log(p));
  } catch { /* leave empty, fall through to VNC_PASSWORD below */ }
" "$PASSWORDS_JSON")

if [ "${#USER_PASSWORDS[@]}" -eq 0 ] && [ -z "$VNC_PASSWORD" ]; then
  VNC_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  echo "[entrypoint] No VNC passwords configured in Settings and VNC_PASSWORD not set — generated one-time password: $VNC_PASSWORD"
  echo "[entrypoint] Set a password in the app's Settings page (or VNC_PASSWORD in the environment) to pin this across restarts."
fi
[ -n "$VNC_PASSWORD" ] && USER_PASSWORDS+=("$VNC_PASSWORD")

# -passwdfile takes PLAIN TEXT passwords, one per line (first line =
# full-access) -- not -storepasswd's obfuscated output, which is for the
# separate -rfbauth option. Piping storepasswd output into a passwdfile
# silently fails auth for every password regardless of length; confirmed
# both here and independently the same night on a second x11vnc
# deployment. No obfuscation step needed.
#
# The "read:" prefix is NOT cosmetic -- per x11vnc's own source
# (connections.c, the passwdfile branch in the per-connection accept
# path), a plain `-passwdfile FILE` is only ever read ONCE, at process
# startup. Re-reading on each new connection attempt (the whole point of
# the live-refresh mechanism this file feeds) only happens when invoked
# as `-passwdfile read:FILE`. Without this prefix, x11vnc silently keeps
# authenticating against whatever was in the file at boot forever,
# ignoring every later rewrite -- confirmed live: the file and its
# content were always correct, but every connection attempt kept
# failing against the original boot-time password regardless.
printf '%s\n' "${USER_PASSWORDS[@]}" > /tmp/.vnc/passwd
x11vnc -display :99 -forever -quiet -passwdfile read:/tmp/.vnc/passwd &

# Live password refresh (both a push-on-save HTTP listener and a 60s
# fallback poll) now lives in src/poll.js via refreshVncPasswordFile() in
# lib.js -- this boot-time block only needs to get x11vnc a valid passwd
# file to start with, before poll.js is even running yet.

# Browser-based access (noVNC) so connecting doesn't require a native VNC
# client to be installed -- proxies the same authenticated VNC session
# (x11vnc's password prompt still applies) over a plain HTTP/WebSocket
# port, reachable directly since this container has its own macvlan IP.
websockify --web=/usr/share/novnc 6080 localhost:5900 &

echo "[entrypoint] Ready. VNC on :5900, browser access on :6080/vnc.html (${#USER_PASSWORDS[@]} password(s) accepted). Poll loop starting."
echo "[entrypoint] One-time login: docker exec -it <container> node src/login.js amazon|walmart"

exec node src/poll.js
