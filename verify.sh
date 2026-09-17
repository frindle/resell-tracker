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

# === migration is a GATED deliverable (root-cause fix, Penn 2026-09-17) ======
# The first dispatch shipped a migration whose SQL was INVALID SQLite -- a
# `UNIQUE INDEX ... (...)` declared INSIDE `CREATE TABLE(...)`. `prisma validate`
# gates the SCHEMA, not the migration, so it went green. Gate the migration
# itself: it must EXIST, APPLY to a throwaway sqlite db, and express addressKey
# uniqueness as a SEPARATE `CREATE UNIQUE INDEX` (the only valid SQLite form).
echo "=== SavedAddress migration: exists, applies to sqlite, separate unique index ==="
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "  FAIL: sqlite3 not on PATH -- cannot gate the migration SQL"; fails=$((fails+1))
else
  SAVEDMIG=$(grep -rIl 'CREATE TABLE "SavedAddress"' prisma/migrations 2>/dev/null | head -1)
  if [ -z "$SAVEDMIG" ]; then
    echo "  FAIL: no migration under prisma/migrations creates the SavedAddress table"; fails=$((fails+1))
  else
    echo "  ok: migration creating SavedAddress present ($SAVEDMIG)"
    # (a) the WHOLE chain, incl. the new migration, must apply to a fresh sqlite db
    _MDB=/tmp/_verify_mig.$$.db; rm -f "$_MDB"; _mig_ok=1
    for _m in $(find prisma/migrations -name migration.sql 2>/dev/null | LC_ALL=C sort); do
      if ! sqlite3 -bail "$_MDB" < "$_m" >/tmp/_verify_mig.$$.log 2>&1; then
        echo "  FAIL: migration does not apply to sqlite: $_m"; sed 's/^/    /' /tmp/_verify_mig.$$.log; _mig_ok=0; break
      fi
    done
    if [ "$_mig_ok" = 1 ]; then echo "  ok: full migration chain applies cleanly to sqlite"; else fails=$((fails+1)); fi
    rm -f "$_MDB" /tmp/_verify_mig.$$.log
    # (b) adversarial FORM pin: the invalid inline form has NO separate statement.
    if grep -qiE 'CREATE[[:space:]]+UNIQUE[[:space:]]+INDEX.*SavedAddress' "$SAVEDMIG"; then
      echo "  ok: addressKey uniqueness is a SEPARATE CREATE UNIQUE INDEX statement"
    else
      echo "  FAIL: no separate CREATE UNIQUE INDEX for SavedAddress (an inline UNIQUE INDEX inside CREATE TABLE is invalid SQLite)"; fails=$((fails+1))
    fi
  fi
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
