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
# bigger exposure. Set VNC_PASSWORD in the environment; if unset, a
# random one is generated and printed ONCE to the container log — read it
# with `docker logs <container>` before connecting.
if [ -z "$VNC_PASSWORD" ]; then
  VNC_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  echo "[entrypoint] VNC_PASSWORD not set — generated one-time password: $VNC_PASSWORD"
  echo "[entrypoint] Set VNC_PASSWORD in the environment to pin this across restarts."
fi
mkdir -p /tmp/.vnc
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vnc/passwd >/dev/null
x11vnc -display :99 -forever -quiet -rfbauth /tmp/.vnc/passwd &

echo "[entrypoint] Ready. VNC on :5900 (password set). Poll loop starting."
echo "[entrypoint] One-time login: docker exec -it <container> node src/login.js amazon|walmart"

exec node src/poll.js
