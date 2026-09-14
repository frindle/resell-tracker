#!/usr/bin/env bash
# verify for: rt-saved-address-schema (Prisma schema DDL task)
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0
SCHEMA=prisma/schema.prisma
[ -f "$SCHEMA" ] || { echo "  FAIL: $SCHEMA missing"; exit 1; }

echo "=== env bootstrap ==="
if [ -L ./node_modules ] && [ ! -e ./node_modules ]; then
  echo "  node_modules is a dangling symlink -- removing so npm can install"
  rm -f ./node_modules
fi
if [ ! -d ./node_modules ]; then
  echo "  node_modules absent -- npm ci for env parity"
  if [ -f package-lock.json ]; then _NPM="npm ci"; else _NPM="npm install"; fi
  if $_NPM >/tmp/_verify_npm.$$.log 2>&1; then echo "  ok: $_NPM"; else echo "  FAIL: $_NPM failed"; tail -20 /tmp/_verify_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_verify_npm.$$.log
fi

echo "=== prisma validate (schema is well-formed) ==="
# Authoritative structural gate: a malformed model / bad attribute / broken
# relation makes prisma validate non-zero. Does NOT connect to the DB.
if npx --yes prisma validate >/tmp/_verify_pv.$$.log 2>&1; then
  echo "  ok: prisma validate passed"
else
  echo "  FAIL: prisma validate failed"; tail -25 /tmp/_verify_pv.$$.log; fails=$((fails+1))
fi
rm -f /tmp/_verify_pv.$$.log

echo "=== SavedAddress model block present ==="
# Extract exactly the SavedAddress model block so each field asserted below
# must live INSIDE this model (not merely somewhere in the file -- an adversary
# could otherwise satisfy a bare grep with an unrelated model).
BLOCK=$(awk '
  /^model[[:space:]]+SavedAddress[[:space:]]*\{/ {inb=1}
  inb {print}
  inb && /^\}/ {inb=0}
' "$SCHEMA")
if [ -z "$BLOCK" ]; then
  echo "  FAIL: no SavedAddress model block found"; fails=$((fails+1))
else
  echo "  ok: SavedAddress block found"
fi

# Each required field/attribute MUST appear inside the SavedAddress block.
# A mutated field name (the relevance gate flips added lines) drops out of the
# block and is caught here.
require_in_block() {
  if printf '%s\n' "$BLOCK" | grep -qE "$1"; then
    echo "  ok: SavedAddress has $2"
  else
    echo "  FAIL: SavedAddress missing $2"; fails=$((fails+1))
  fi
}
echo "=== required fields inside SavedAddress ==="
require_in_block '(^|[^A-Za-z])id[[:space:]]'                       'id'
require_in_block '(^|[^A-Za-z])retailer[[:space:]]'                 'retailer'
require_in_block '(^|[^A-Za-z])addressKey[[:space:]]'               'addressKey'
require_in_block '(^|[^A-Za-z])addressKey[[:space:]].*@unique'      'addressKey @unique'
require_in_block '(^|[^A-Za-z])name[[:space:]]'                     'name'
require_in_block '(^|[^A-Za-z])line1[[:space:]]'                    'line1'
require_in_block '(^|[^A-Za-z])city[[:space:]]'                     'city'
require_in_block '(^|[^A-Za-z])state[[:space:]]'                    'state'
require_in_block '(^|[^A-Za-z])zip[[:space:]]'                      'zip'
require_in_block '(^|[^A-Za-z])country[[:space:]]'                  'country'
require_in_block '(^|[^A-Za-z])createdAt[[:space:]].*@default\(now\(\)\)' 'createdAt @default(now())'
require_in_block '(^|[^A-Za-z])updatedAt[[:space:]].*@updatedAt'    'updatedAt @updatedAt'

echo "=== spec literals ==="
if python3 ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
