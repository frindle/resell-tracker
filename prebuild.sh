#!/usr/bin/env bash
# Pre-builds the resell-tracker image in the background so ./update.sh is fast.
#
# Usage:  ./prebuild.sh               # build origin/main if it is new (what cron runs)
#         ./prebuild.sh --install     # install the midnight + every-15-minutes cron entries
#         ./prebuild.sh --uninstall   # remove them
#         ./prebuild.sh --status      # last pre-built commit and the last log lines
#
# What it does: fetches origin, and when origin/main is a commit nobody has
# built yet, resets this deploy clone to it and runs `docker-compose build app`
# (or `docker compose build app`). Docker's layer cache keeps the result.
# Commits that change no image input (docs, tests, CI) are skipped, so the
# image is not retagged for nothing.
#
# What it never does: `up`, restart, stop, or write .last-built-sha. The running
# container keeps its old image until you run ./update.sh. That build then finds
# every layer already cached (same commit, same BUILD_SHA) and finishes in
# seconds, and its `up -d` is what swaps the container.
#
# Note the freshly built image carries the same tag as the running one, so any
# `docker-compose up -d` that recreates the container (a manual up, or compose
# noticing the image changed) starts the NEW code. A plain restart of the
# existing container, or a reboot, keeps running the old image.
#
# Like update.sh, this treats the checkout as a deploy clone with no local
# changes: it does `git reset --hard origin/main`. The running container does
# not read the checkout, so that is safe while it runs.
#
# update.sh takes no lock, so avoid running it while a pre-build is in flight
# (see --status); it would only share the cached layers, not corrupt anything.

set -e

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"
SELF="$REPO_DIR/$(basename "$0")"

# cron starts with a bare PATH; docker-compose usually lives in /usr/local/bin.
export PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin"

PREBUILT_MARKER=.last-prebuilt-sha
BUILT_MARKER=.last-built-sha
LOCK_FILE=/tmp/resell-tracker-prebuild.lock
LOG_FILE=/tmp/resell-tracker-prebuild.log
FAILED_FILE=/tmp/resell-tracker-prebuild.failed
LOG_KEEP=200
RETRY_AFTER_FAIL=21600   # seconds; do not hammer a commit whose build failed
CRON_DIR=/boot/config/plugins/dynamix
CRON_FILE="$CRON_DIR/resell-tracker-prebuild.cron"

cron_lines() {
  echo "0 0 * * * \"$SELF\" --cron"
  echo "*/15 * * * * \"$SELF\" --cron"
}

refresh_cron() {
  if command -v update_cron >/dev/null 2>&1; then
    update_cron
    echo "ran update_cron"
  else
    echo "update_cron not found; the cron daemon will not see the change until it is reloaded"
  fi
}

install_cron() {
  if [ ! -d "$CRON_DIR" ]; then
    echo "$CRON_DIR not found (not Unraid?). Add these two lines to your crontab:"
    cron_lines
    return 0
  fi
  echo "# resell-tracker: pre-build the Docker image (never restarts the container)" > "$CRON_FILE.tmp"
  cron_lines >> "$CRON_FILE.tmp"
  mv "$CRON_FILE.tmp" "$CRON_FILE"
  echo "wrote $CRON_FILE:"
  cron_lines
  echo "log: $LOG_FILE (last $LOG_KEEP lines kept)"
  refresh_cron
}

uninstall_cron() {
  if [ -f "$CRON_FILE" ]; then
    rm -f "$CRON_FILE"
    echo "removed $CRON_FILE"
    refresh_cron
  else
    echo "nothing to remove ($CRON_FILE does not exist)"
  fi
}

read_marker() {
  if [ -r "$1" ]; then tr -d '[:space:]' < "$1" 2>/dev/null || true; fi
}

status() {
  local sha
  sha="$(read_marker "$PREBUILT_MARKER")"
  echo "last pre-built commit: ${sha:-none}"
  sha="$(read_marker "$BUILT_MARKER")"
  echo "last update.sh build:  ${sha:-none}"
  if command -v flock >/dev/null 2>&1 && ! ( exec 9>"$LOCK_FILE"; flock -n 9 ); then
    echo "a pre-build is running right now"
  fi
  if [ -f "$LOG_FILE" ]; then
    echo "--- last lines of $LOG_FILE ---"
    tail -n 20 "$LOG_FILE"
  else
    echo "no log yet ($LOG_FILE)"
  fi
}

trim_log() {
  [ -f "$LOG_FILE" ] || return 0
  tail -n "$LOG_KEEP" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
}

# True (0) when the path ships in the image. MUST stay in step with
# isImageInput in lib/buildInputs.ts: same rules, same order.
is_image_input() {
  case "$1" in
    Dockerfile|Dockerfile.all-in-one|docker-compose.yml|.dockerignore|package.json|package-lock.json) return 0 ;;
    public/*|docker/*|sidecar/*|giftcard-ocr/*|prisma/*) return 0 ;;
    *.md) return 1 ;;
    .github/*|workers/*|tests/*) return 1 ;;
    update.sh|prebuild.sh|.gitignore|.gitattributes) return 1 ;;
    *.test.ts|*.test.tsx|*.test.js|*.test.mjs) return 1 ;;
  esac
  return 0
}

# changes_image_input <base> <target>: true when any changed file is an image
# input. If the diff itself fails, say yes so the caller builds.
changes_image_input() {
  local files f
  files="$(git diff --name-only --no-renames -z "$1" "$2" 2>/dev/null | tr '\0' '\n')" || return 0
  [ -n "$files" ] || return 0
  while IFS= read -r f; do
    if is_image_input "$f"; then return 0; fi
  done <<< "$files"
  return 1
}

# prebuild <from_cron>: the lock is already held by the caller.
prebuild() {
  local from_cron="$1" target short done_sha built_sha base now f_sha f_at
  if ! git fetch origin >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) git fetch failed; will try again next run"
    return 1
  fi
  target="$(git rev-parse origin/main)"
  done_sha="$(read_marker "$PREBUILT_MARKER")"
  built_sha="$(read_marker "$BUILT_MARKER")"
  # Nothing new: stay silent so the 15-minute schedule leaves no trace.
  if [ "$target" = "$done_sha" ] || [ "$target" = "$built_sha" ]; then return 0; fi

  if [ "$from_cron" = 1 ] && [ -r "$FAILED_FILE" ]; then
    read -r f_sha f_at < "$FAILED_FILE" || true
    # A corrupt marker (non-numeric time) counts as no marker.
    case "$f_at" in
      ""|*[!0-9]*) f_at="" ;;
    esac
    now="$(date +%s)"
    if [ "$f_sha" = "$target" ] && [ -n "$f_at" ] && [ $((now - f_at)) -lt "$RETRY_AFTER_FAIL" ]; then
      return 0
    fi
  fi

  # Skip commits that change nothing the image contains. The base is the commit
  # the current image came from; when it is unknown or not an ancestor, build.
  base="${built_sha:-$done_sha}"
  if [ -n "$base" ] \
    && git cat-file -e "$base^{commit}" 2>/dev/null \
    && git merge-base --is-ancestor "$base" "$target" 2>/dev/null \
    && ! changes_image_input "$base" "$target"; then
    echo "$(date -u +%FT%TZ) ${target:0:7}: no image inputs changed since ${base:0:7}; skipping build"
    return 0
  fi

  git reset --hard origin/main >/dev/null
  short="$(git rev-parse --short HEAD)"
  echo "=== $(date -u +%FT%TZ) pre-building BUILD_SHA=$short ==="

  local cmd=()
  # nice/ionice only lower the client's priority; the build runs in the Docker daemon.
  cmd+=(nice -n 19)
  if command -v ionice >/dev/null 2>&1; then cmd+=(ionice -c3); fi
  if command -v docker-compose >/dev/null 2>&1; then
    cmd+=(docker-compose build app)
  else
    cmd+=(docker compose build app)
  fi

  # BUILD_SHA matches what update.sh passes, so its later build hits the cache.
  if BUILD_SHA="$short" "${cmd[@]}"; then
    echo "$target" > "$PREBUILT_MARKER"
    rm -f "$FAILED_FILE"
    echo "=== pre-build done: $short ==="
  else
    echo "$target $(date +%s)" > "$FAILED_FILE"
    echo "=== pre-build FAILED: $short ==="
    return 1
  fi
}

case "${1:-}" in
  --install) install_cron; exit 0 ;;
  --uninstall) uninstall_cron; exit 0 ;;
  --status) status; exit 0 ;;
  ""|--cron) ;;
  *) echo "usage: $0 [--install|--uninstall|--status]" >&2; exit 2 ;;
esac

if ! command -v flock >/dev/null 2>&1; then
  echo "flock not found; cannot guard against overlapping runs" >&2
  exit 1
fi
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

if [ "${1:-}" = "--cron" ]; then
  # Output goes to the log; it is trimmed when the run ends.
  exec >> "$LOG_FILE" 2>&1
  trap trim_log EXIT
  prebuild 1
else
  prebuild 0
fi
