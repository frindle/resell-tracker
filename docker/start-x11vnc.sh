#!/bin/bash
# x11vnc, plus the VNC-password bootstrap that used to live inline in
# sidecar/entrypoint.sh.
#
# Password-protected -- unlike the teams-shifts-exporter-docker reference
# (-nopw), this container's browser handles real Amazon/Walmart credentials,
# so an unauthenticated VNC listener on the shared macvlan is a materially
# bigger exposure.
#
# Multi-user: there's one shared X11/VNC session (not one per user), so
# "per-user" here means *who's allowed to connect*, not separate sessions.
# Every user's `vnc_password` Setting (set in the app's Settings page) is
# fetched via GET /api/sidecar/vnc-passwords and accepted -- x11vnc's
# -passwdfile accepts any of several stored passwords. Falls back to
# VNC_PASSWORD (or a random one-time password printed to the log) if no user
# has set one yet or the app is unreachable at boot.
set -uo pipefail

TAG=x11vnc
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
TRACKER_URL="${TRACKER_URL:-$(app_url)}"
FETCH_TIMEOUT="${VNC_PASSWORD_FETCH_TIMEOUT:-180}"
RETRY_SLEEP="${VNC_FETCH_RETRY_SLEEP:-5}"
X_WAIT_TIMEOUT="${X_WAIT_TIMEOUT:-90}"

# --- dependency 1: the X server ------------------------------------------
wait_for_x ":${DISPLAY_NUM}" "$X_WAIT_TIMEOUT" || exit 1

# Ensure NumLock is enabled so numpad keys emit digits (not Home/End/arrows)
# in the VNC session -- the old standalone sidecar ran this at startup too.
# Non-fatal: a numlockx hiccup must never block x11vnc from starting.
DISPLAY=":${DISPLAY_NUM}" numlockx on || log "numlockx failed (non-fatal)"

# numlockx alone proved insufficient over noVNC: with a client NumLock ON,
# the browser sends KP_<digit> keysyms and x11vnc's default modtweak can
# inject them without the NumLock modifier held, so keycode 87 etc. resolve
# to their KP_End/KP_Home (nav) alternate instead of the digit -- the numpad
# typed arrows even with server NumLock on. Fix deterministically at the
# keymap: pin each numpad DIGIT/decimal keycode to its KP_<digit> keysym in
# every group position, removing the nav alternate entirely. Now the numpad
# always emits digits regardless of NumLock state or modtweak. This touches
# ONLY the 11 numeric keys -- letters/shift/symbols (password typing) are
# untouched -- and losing numpad-as-navigation is a non-issue for entering
# order/verification codes. Requires x11-xserver-utils (xmodmap). Non-fatal.
DISPLAY=":${DISPLAY_NUM}" xmodmap - <<'XMODMAP' 2>/dev/null || log "xmodmap numpad remap failed (non-fatal)"
keycode 79 = KP_7 KP_7 KP_7 KP_7
keycode 80 = KP_8 KP_8 KP_8 KP_8
keycode 81 = KP_9 KP_9 KP_9 KP_9
keycode 83 = KP_4 KP_4 KP_4 KP_4
keycode 84 = KP_5 KP_5 KP_5 KP_5
keycode 85 = KP_6 KP_6 KP_6 KP_6
keycode 87 = KP_1 KP_1 KP_1 KP_1
keycode 88 = KP_2 KP_2 KP_2 KP_2
keycode 89 = KP_3 KP_3 KP_3 KP_3
keycode 90 = KP_0 KP_0 KP_0 KP_0
keycode 91 = KP_Decimal KP_Decimal KP_Decimal KP_Decimal
XMODMAP

# --- dependency 2: the app -----------------------------------------------
#
# The old sidecar container fetched these passwords from the app container
# over the macvlan and could beat it to readiness. Two consecutive boots on
# 2026-08-21 both landed on "No VNC passwords configured" right after an
# update.sh-triggered restart, because a single unretried curl raced the
# app's cold start; the fix then was a 6-attempt backoff.
#
# In one container we can do strictly better AND keep that safety net:
#   1. supervisord starts `app` at a lower priority number than this program,
#      so the Next.js process already exists by the time we get here;
#   2. we block on the app actually ANSWERING on loopback (not just having
#      bound the port) for up to FETCH_TIMEOUT seconds;
#   3. the 6-attempt backoff below is still there, unchanged, as the safety
#      net for the case where the app answers /api/sidecar/info but is not yet
#      serving /api/sidecar/vnc-passwords, or is mid-restart.
# Deleting the retry would be trading a proven fix for an assumption.
wait_for_http "${TRACKER_URL}/api/sidecar/info" "$FETCH_TIMEOUT" || \
  log "app not confirmed ready — falling through to the bounded retry anyway"

mkdir -p /tmp/.vnc
PASSWORDS_JSON=""
if [ -n "${SIDECAR_SHARED_SECRET:-}" ] && [ -n "$TRACKER_URL" ]; then
  for attempt in 1 2 3 4 5 6; do
    PASSWORDS_JSON=$(curl -sf --max-time 10 -H "X-Sidecar-Secret: $SIDECAR_SHARED_SECRET" \
      "$TRACKER_URL/api/sidecar/vnc-passwords" || true)
    if [ -n "$PASSWORDS_JSON" ]; then
      break
    fi
    log "vnc-passwords fetch attempt $attempt failed (app likely still starting) — retrying..."
    sleep "$RETRY_SLEEP"
  done
else
  log "SIDECAR_SHARED_SECRET unset — skipping the per-user password fetch"
fi

# Declared up front so `set -u` is safe even if readarray produces nothing.
declare -a USER_PASSWORDS=()
readarray -t USER_PASSWORDS < <(node -e "
  try {
    const d = JSON.parse(process.argv[1] || '{}');
    (d.passwords || []).forEach(p => console.log(p));
  } catch { /* leave empty, fall through to VNC_PASSWORD below */ }
" "$PASSWORDS_JSON")

if [ "${#USER_PASSWORDS[@]}" -eq 0 ] && [ -z "${VNC_PASSWORD:-}" ]; then
  # Pinned to /data so it survives an x11vnc restart -- in the old container
  # this script ran once per container life, but supervisord can restart this
  # program on its own, and regenerating the password every time would keep
  # invalidating a session the user is in the middle of connecting to.
  GEN_FILE="${DATA_DIR:-/data}/.vnc-generated-password"
  if [ -s "$GEN_FILE" ]; then
    VNC_PASSWORD="$(cat "$GEN_FILE")"
    log "No VNC passwords configured in Settings and VNC_PASSWORD not set — reusing the generated password from $GEN_FILE: $VNC_PASSWORD"
  else
    VNC_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
    ( umask 077; printf '%s' "$VNC_PASSWORD" > "$GEN_FILE" ) || true
    log "No VNC passwords configured in Settings and VNC_PASSWORD not set — generated one-time password: $VNC_PASSWORD"
  fi
  log "Set a password in the app's Settings page (or VNC_PASSWORD in the environment) to pin this across restarts."
fi
[ -n "${VNC_PASSWORD:-}" ] && USER_PASSWORDS+=("$VNC_PASSWORD")

if [ "${#USER_PASSWORDS[@]}" -eq 0 ]; then
  log "no VNC password available at all — refusing to start an unauthenticated listener"
  exit 1
fi

# -passwdfile takes PLAIN TEXT passwords, one per line (first line =
# full-access) -- not -storepasswd's obfuscated output, which is for the
# separate -rfbauth option. Piping storepasswd output into a passwdfile
# silently fails auth for every password regardless of length.
#
# The "read:" prefix is NOT cosmetic -- per x11vnc's own source
# (connections.c, the passwdfile branch in the per-connection accept path), a
# plain `-passwdfile FILE` is only ever read ONCE, at process startup.
# Re-reading on each new connection attempt (the whole point of the
# live-refresh mechanism src/poll.js feeds) only happens when invoked as
# `-passwdfile read:FILE`. Without this prefix x11vnc silently keeps
# authenticating against whatever was in the file at boot forever, ignoring
# every later rewrite.
( umask 077; printf '%s\n' "${USER_PASSWORDS[@]}" > /tmp/.vnc/passwd )

log "starting x11vnc on :5900 (${#USER_PASSWORDS[@]} password(s) accepted); noVNC on :6080/vnc.html"
exec x11vnc -display ":${DISPLAY_NUM}" -forever -quiet -passwdfile read:/tmp/.vnc/passwd
