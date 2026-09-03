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
#   3. OMP_NUM_THREADS=1 / MKL_NUM_THREADS=1 / waitress threads=1, all
#      unchanged from the original service. Measured on a Xeon E5-2699 v4,
#      raising OMP_NUM_THREADS from 1 to 4 changed per-image latency by under
#      3% (52.5s -> 52.1s), so the process is effectively single-threaded
#      anyway and item 1 is mostly belt-and-braces.
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
WIDTH="${GIFTCARD_OCR_CPUS:-2}"

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
