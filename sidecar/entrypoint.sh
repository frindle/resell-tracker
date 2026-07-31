#!/bin/bash
set -e

mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/debug"

# Virtual framebuffer — every Playwright launch in this container runs
# headed (headless:false) against this display, both the one-time
# interactive login and the unattended poll-loop runs. See Dockerfile
# comment for why (bot-detection research finding).
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
  PASSWORDS_JSON=$(curl -sf -H "X-Sidecar-Secret: $SIDECAR_SHARED_SECRET" "$TRACKER_URL/api/sidecar/vnc-passwords" || true)
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

i=0
for pw in "${USER_PASSWORDS[@]}"; do
  x11vnc -storepasswd "$pw" "/tmp/.vnc/entry_$i" >/dev/null
  i=$((i + 1))
done
cat /tmp/.vnc/entry_* > /tmp/.vnc/passwd
rm -f /tmp/.vnc/entry_*
x11vnc -display :99 -forever -quiet -passwdfile /tmp/.vnc/passwd &

echo "[entrypoint] Ready. VNC on :5900 (${#USER_PASSWORDS[@]} password(s) accepted). Poll loop starting."
echo "[entrypoint] One-time login: docker exec -it <container> node src/login.js amazon|walmart"

exec node src/poll.js
