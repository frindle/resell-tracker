#!/bin/bash
# Gift-card OCR (PaddleOCR + Flask/waitress), CPU only.
#
# ---------------------------------------------------------------------------
# THE CPU CAP -- read this before changing anything here.
#
# As three compose services, this one carried `cpus: 2.0`. That was a real
# cgroup quota and it guaranteed an OCR burst "can never starve the array, the
# app container, or the sidecar's Chrome". One container means one cgroup, so
# that per-service quota is GONE and cannot be recreated from inside an
# unprivileged container. What replaces it, in order of how much it actually
# buys:
#
#   1. CPU AFFINITY (taskset). This is the real substitute. Pinning the OCR
#      process to a fixed subset of CPUs is a hard ceiling: 2 CPUs of affinity
#      is an absolute cap of 2 cores' worth of work, the same practical
#      ceiling `cpus: 2.0` gave. It is not identical -- a quota lets a process
#      float across all cores and take 2 cores' worth in aggregate, while
#      affinity nails it to two specific cores -- but the protection that
#      mattered (everything else keeps at least the other cores) is preserved.
#      The set is derived from sched_getaffinity, so it degrades correctly if
#      the container itself is later given a restricted cpuset.
#
#   2. nice. Even within its two pinned CPUs, OCR yields to the app and to
#      Chrome. A quota could not do this; the old setup had no equivalent.
#
#   3. Threads. The OCR now runs OCR_POOL_SIZE engine instances (default 2),
#      each with OCR_THREADS threads (default 4), so the default allowance is
#      8 CPUs and the pinning width below defaults to the same product, but
#      always capped so at least 2 of the container's cores stay free (threads
#      are reduced first, and a log line says so). A
#      quiet-box benchmark of this engine gave ~1.5x at 4 threads and ~1.7x
#      at 8, so two instances of 4 use the cores better than one of 8.
#
# What is genuinely lost: memory and blkio were never limited per-service
# either, and now a container-level `cpus:` in docker-compose.yml caps the
# WHOLE stack rather than just OCR. See the comment on that key.
#
# Escape hatch if this is ever not enough: GIFTCARD_OCR_CPUS controls the
# affinity width (0 disables pinning entirely), GIFTCARD_OCR_NICE the
# priority.
# ---------------------------------------------------------------------------
set -euo pipefail

TAG=giftcard-ocr
# Resolved relative to this script, not hardcoded to /opt/docker, so the
# wrappers can be exercised straight out of the repo checkout.
# shellcheck source=lib.sh
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

cd /opt/giftcard-ocr

# server.py reads PORT, and PORT is 3000 container-wide for Next.js. Override
# it for this process only -- do NOT drop this line or OCR races the app for
# :3000 and one of them dies on EADDRINUSE.
export PORT="${GIFTCARD_OCR_PORT:-8080}"

NICE="${GIFTCARD_OCR_NICE:-15}"
# Threads per engine instance times instances (engine.py reads the same two
# variables), so the pinned cores match what the process will actually run.
# Anything that is not a positive integer falls back to the default.
posint() { case "$1" in ''|*[!0-9]*|0) echo "$2" ;; *) echo "$1" ;; esac; }
OCR_THREADS="$(posint "${OCR_THREADS:-}" 4)"
OCR_POOL_SIZE="$(posint "${OCR_POOL_SIZE:-}" 2)"

# Cores this container may really use: the cgroup CPU quota when there is one
# (v2 cpu.max, then v1 cfs files), else what nproc reports (affinity-aware).
USABLE="$(nproc 2>/dev/null || echo 1)"
QUOTA="" PERIOD=""
if [ -r /sys/fs/cgroup/cpu.max ]; then
  read -r QUOTA PERIOD < /sys/fs/cgroup/cpu.max || true
elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
  QUOTA="$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"
  PERIOD="$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
fi
case "$QUOTA$PERIOD" in
  ''|*[!0-9]*) ;;  # "max", "-1" or unreadable: no quota
  *)
    if [ "$PERIOD" -gt 0 ]; then
      QCORES=$(( (QUOTA + PERIOD - 1) / PERIOD ))
      [ "$QCORES" -lt 1 ] && QCORES=1
      [ "$QCORES" -lt "$USABLE" ] && USABLE="$QCORES"
    fi
    ;;
esac
[ "$USABLE" -lt 1 ] && USABLE=1

# Leave at least 2 cores for the web app and the browser sharing this container.
BUDGET=$((USABLE - 2))
[ "$BUDGET" -lt 1 ] && BUDGET=1
if [ $((OCR_THREADS * OCR_POOL_SIZE)) -gt "$BUDGET" ]; then
  NEW_THREADS=$((BUDGET / OCR_POOL_SIZE))
  [ "$NEW_THREADS" -lt 1 ] && NEW_THREADS=1
  log "OCR threads reduced ${OCR_THREADS} -> ${NEW_THREADS} (pool=${OCR_POOL_SIZE}, usable cores=${USABLE}, keeping 2 free)"
  OCR_THREADS="$NEW_THREADS"
fi
export OCR_THREADS OCR_POOL_SIZE OMP_NUM_THREADS="$OCR_THREADS" MKL_NUM_THREADS="$OCR_THREADS"

# Pinning width: an explicit GIFTCARD_OCR_CPUS is honoured but never beyond the
# container's cores; the default never exceeds usable-2.
DEFAULT_WIDTH=$((OCR_THREADS * OCR_POOL_SIZE))
[ "$DEFAULT_WIDTH" -gt "$BUDGET" ] && DEFAULT_WIDTH="$BUDGET"
WIDTH="${GIFTCARD_OCR_CPUS:-$DEFAULT_WIDTH}"
case "$WIDTH" in ''|*[!0-9]*) WIDTH="$DEFAULT_WIDTH" ;; esac
[ "$WIDTH" -gt "$USABLE" ] && WIDTH="$USABLE"

CPUSET="$(python3 -c "
import os
cpus = sorted(os.sched_getaffinity(0))
try:
    n = int('${WIDTH}')
except ValueError:
    n = 2
print(','.join(str(c) for c in (cpus[-n:] if 0 < n < len(cpus) else cpus)))
")"

if [ "$WIDTH" = "0" ] || [ -z "$CPUSET" ]; then
  log "CPU pinning disabled (GIFTCARD_OCR_CPUS=$WIDTH); nice=$NICE, PORT=$PORT, model_set=${OCR_MODEL_SET:-medium}"
  exec nice -n "$NICE" /opt/ocr-venv/bin/python server.py
fi

log "pinned to CPU(s) ${CPUSET} (substitute for the old \`cpus: 2.0\`), nice=$NICE, PORT=$PORT, model_set=${OCR_MODEL_SET:-medium}"
exec nice -n "$NICE" taskset -c "$CPUSET" /opt/ocr-venv/bin/python server.py
