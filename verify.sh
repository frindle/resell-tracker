#!/usr/bin/env bash
# verify for: sync-status-drag-resize (--kind expression)
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0
NODE=$(command -v node)     # the queue daemon runs under launchd's PATH
[ -n "$NODE" ] || { echo "  FAIL: node not on PATH"; exit 1; }

echo "=== env bootstrap ==="
# A DANGLING node_modules symlink (the scaffold linked the worktree to the
# source, then the source's node_modules went away) is `[ ! -d ]`-true, so the
# old check fell through to `npm ci`, which then errors on the pre-existing
# symlink path. Remove a broken symlink first so npm can install cleanly.
if [ -L ./node_modules ] && [ ! -e ./node_modules ]; then
  echo "  node_modules is a dangling symlink -- removing so npm can install"
  rm -f ./node_modules
fi
if [ ! -d ./node_modules ]; then
  echo "  node_modules absent -- npm ci for env parity (tsc/tests need deps)"
  if [ -f package-lock.json ]; then _NPM="npm ci"; else _NPM="npm install"; fi
  if $_NPM >/tmp/_verify_npm.$$.log 2>&1; then echo "  ok: $_NPM"; else echo "  FAIL: $_NPM failed"; tail -20 /tmp/_verify_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_verify_npm.$$.log
fi
_SCHEMA=""
[ -f prisma/schema.prisma ] && _SCHEMA=prisma/schema.prisma
[ -z "$_SCHEMA" ] && _SCHEMA=$(ls prisma/schema/*.prisma 2>/dev/null | head -1)
if [ -n "$_SCHEMA" ] && grep -q "generator" "$_SCHEMA" 2>/dev/null; then
  _OUT=$(grep -oE 'output[[:space:]]*=[[:space:]]*"[^"]+"' "$_SCHEMA" | head -1 | sed -E 's/.*"([^"]+)"/\1/')
  _SDIR=$(dirname "$_SCHEMA")
  _SKIP_PRISMA=""
  case "$_OUT" in
    /*) _ABS="$_OUT" ;;
    "") _ABS="node_modules/.prisma/client"
        # Default output lands INSIDE node_modules. When that is symlinked to the
        # source checkout, `prisma generate` writes into the SOURCE repo (outside
        # this worktree, and wrong if the schemas differ). Skip rather than
        # corrupt the source -- generate in the source repo, or set a
        # worktree-local `output` in the schema's generator block.
        if [ -L node_modules ]; then _SKIP_PRISMA=1; fi ;;
    *)  _ABS="$_SDIR/$_OUT" ;;
  esac
  if [ -n "$_SKIP_PRISMA" ]; then
    echo "  WARN: node_modules is symlinked to the source; skipping default-output prisma generate (would write into the source repo). Generate there, or set a worktree-local output in the schema."
  elif [ -d "$_ABS" ] && [ -n "$(ls -A "$_ABS" 2>/dev/null)" ]; then
    echo "  ok: prisma client present ($_ABS)"
  else
    echo "  prisma client missing ($_ABS) -- npx prisma generate"
    if npx --yes prisma generate >/tmp/_verify_prisma.$$.log 2>&1; then echo "  ok: prisma generate"; else echo "  WARN: prisma generate failed (continuing; tsc may flood with TS7006)"; tail -20 /tmp/_verify_prisma.$$.log; fi
    rm -f /tmp/_verify_prisma.$$.log
  fi
fi

# --- prisma migration apply gate (Penn 2026-09-17) --------------------------
# WHY: a schema-only dispatch (rt-saved-address-schema, job 4ee80100599a) shipped
# a migration whose SQL was INVALID SQLite -- it declared `UNIQUE INDEX ... (...)`
# INSIDE `CREATE TABLE(...)` (valid form is a SEPARATE `CREATE UNIQUE INDEX`).
# `prisma validate` gates the SCHEMA, not the migration file, so the gate went
# GREEN on a migration that `sqlite3` rejects with a parse error. General fix:
# whenever THIS dispatch creates or changes any prisma/migrations/**/migration.sql,
# replay the WHOLE migration chain (in timestamp order, so earlier migrations that
# a new one depends on are present) into a throwaway sqlite db and FAIL on any
# error; then assert no drift vs schema.prisma via `prisma migrate diff`.
# No-op when the dispatch touched no migration -- safe to run in every verify.
if command -v git >/dev/null 2>&1 && command -v sqlite3 >/dev/null 2>&1; then
  # --untracked-files=all: git otherwise COLLAPSES a wholly-new migration dir to
  # `?? prisma/migrations/<dir>/`, hiding the migration.sql filename the grep keys
  # on -- the common case (a dispatch adds a brand-new migration directory).
  _CHANGED_MIG=$(git status --porcelain --untracked-files=all -- prisma/migrations 2>/dev/null | cut -c4- | grep -E '(^|/)migration\.sql$' || true)
  if [ -n "$_CHANGED_MIG" ]; then
    echo "=== prisma migrations apply to throwaway sqlite ==="
    echo "  changed/created migration(s) this dispatch:"; printf '%s\n' "$_CHANGED_MIG" | sed 's/^/    /'
    _MIG_DB="/tmp/_verify_mig.$$.db"; rm -f "$_MIG_DB"
    _mig_ok=1
    for _m in $(find prisma/migrations -name migration.sql 2>/dev/null | LC_ALL=C sort); do
      if ! sqlite3 -bail "$_MIG_DB" < "$_m" >/tmp/_verify_mig.$$.log 2>&1; then
        echo "  FAIL: migration does not apply to sqlite: $_m"; sed 's/^/    /' /tmp/_verify_mig.$$.log; _mig_ok=0; break
      fi
    done
    if [ "$_mig_ok" = 1 ]; then echo "  ok: all migrations apply cleanly to sqlite"; else fails=$((fails+1)); fi
    rm -f "$_MIG_DB" /tmp/_verify_mig.$$.log
    # Bonus (drift): the replayed migration chain must reproduce schema.prisma.
    if [ -f prisma/schema.prisma ]; then
      if [ -x ./node_modules/.bin/prisma ]; then _PRISMA="./node_modules/.bin/prisma"; else _PRISMA="npx --yes prisma"; fi
      echo "=== prisma migrate diff (migrations vs schema.prisma, expect empty) ==="
      $_PRISMA migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code >/tmp/_verify_diff.$$.log 2>&1
      _dc=$?
      if [ "$_dc" = 0 ]; then echo "  ok: no drift between migrations and schema.prisma"
      elif [ "$_dc" = 2 ]; then echo "  FAIL: migrations drift from schema.prisma (migrate diff non-empty)"; sed 's/^/    /' /tmp/_verify_diff.$$.log; fails=$((fails+1))
      else echo "  WARN: prisma migrate diff could not run (rc=$_dc) -- skipping drift assertion"; sed 's/^/    /' /tmp/_verify_diff.$$.log; fi
      rm -f /tmp/_verify_diff.$$.log
    fi
  fi
fi

# Expression mode extracts+evals the target as TEXT, so the fixture is plain ESM
# JS run under node -- no tsx (that is only for resolving a typed import). tsc is
# still the authoritative type gate on the target file.
if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

echo "=== target parses ==="
# ts-parse is a convenience floor (TS analogue of `ast.parse`). NOT authoritative
# here: `tsc --noEmit` below parses AND type-checks the target. The ts-parse
# sidecar needs `typescript` installed in its own dir (bin/ts-mutator); when that
# is absent it cannot load -- WARN rather than FAIL so the gap does not read as a
# broken target.
if "$NODE" '/Users/penn/bin/ts-mutator/ts-parse.mjs' 'components/SyncStatusIndicator.tsx' 2>/tmp/_verify_parse.$$.log; then
  echo "  ok: components/SyncStatusIndicator.tsx parses"
elif grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module) 'typescript'" /tmp/_verify_parse.$$.log; then
  echo "  WARN: ts-parse sidecar not installed (needs 'typescript' in bin/ts-mutator) -- relying on tsc --noEmit below"
else
  echo "  FAIL: components/SyncStatusIndicator.tsx does not parse"; head -5 /tmp/_verify_parse.$$.log; fails=$((fails+1))
fi
rm -f /tmp/_verify_parse.$$.log

echo "=== types (tsc --noEmit) ==="
# Run the project check, but only FAIL when the error is in the file the model
# edited (components/SyncStatusIndicator.tsx). Pre-existing errors elsewhere WARN and pass.
if $TSC --noEmit -p tsconfig.json >/tmp/_verify_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE 'components/SyncStatusIndicator\.tsx[(:]' /tmp/_verify_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in components/SyncStatusIndicator.tsx"; grep -E 'components/SyncStatusIndicator\.tsx[(:]' /tmp/_verify_tsc.$$.log | head -15; fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE components/SyncStatusIndicator.tsx (not this task's) -- passing type gate"
fi
rm -f /tmp/_verify_tsc.$$.log

echo "=== spec literals ==="
if python3 ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "=== behavioural cases (expression extract + eval) ==="
# node (not tsx): the fixture reads the target as text and evals it; nothing to
# type-strip or import-resolve.
if "$NODE" ./verify_impl.mjs; then
  echo "  ok: adversarial cases pass"
else
  echo "  FAIL: adversarial cases failed"; fails=$((fails+1))
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
