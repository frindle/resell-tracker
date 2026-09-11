#!/usr/bin/env bash
# verify for: bfmr-cap-link-to-reservation (--ts-runner node-test)
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

if [ -x ./node_modules/.bin/tsx ]; then TSX="./node_modules/.bin/tsx"; else TSX="npx --yes tsx"; fi
if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

# The new/edited test file(s) this dispatch's fix must make pass.
TEST_FILES="verify.test.ts"

# RUNNER selection: if tsconfig declares compilerOptions.paths (e.g. `@/*`),
# run tests under tsx so the alias resolves; otherwise use the repo's native
# node --test with type-stripping.
#
# We force `--test-reporter=tap` on BOTH runners. WHY: `tsx --test` (the
# path-alias branch) defaults to the SPEC reporter, which prints the count as
# `ℹ tests N`, NOT the TAP `# tests N` the summary grep below keys on. Without
# this a fully-green path-alias run parsed _ntests=0 and mis-fired
# SCAFFOLD_INCOMPLETE -- a false NO-GO on correct work, on every TS path-alias
# repo (resell-tracker, any Next.js repo). Forcing TAP makes the summary line
# deterministic regardless of which runner (or reporter default) is in play.
#
# `require("./tsconfig.json")` THROWS on the
# `// comment`s and trailing commas that `tsc --init` emits (JSONC, not JSON) --
# a throw made HAS_PATHS="0", picked the wrong runner, and left `@/` imports
# unresolved. Parse tolerantly (strip comments + trailing commas) and follow
# one level of `extends` (relative, absolute, or a package like @tsconfig/next).
HAS_PATHS=$("$NODE" -e 'const fs=require("fs"),path=require("path");const strip=s=>s.replace(/\/\*[\s\S]*?\*\//g,"").replace(/(^|[^:])\/\/.*$/gm,"$1").replace(/,\s*([}\]])/g,"$1");const load=f=>{try{return JSON.parse(strip(fs.readFileSync(f,"utf8")))}catch(e){return null}};const hp=(f,d)=>{if(!f||d>5)return false;const c=load(f);if(!c)return false;if(c.compilerOptions&&c.compilerOptions.paths&&Object.keys(c.compilerOptions.paths).length)return true;if(c.extends){let b;if(c.extends.startsWith(".")||path.isAbsolute(c.extends)){b=path.resolve(path.dirname(f),c.extends.endsWith(".json")?c.extends:c.extends+".json")}else{try{b=require.resolve(c.extends,{paths:[path.dirname(f)]})}catch(e){return false}}return hp(b,d+1)}return false};process.stdout.write(hp("./tsconfig.json",0)?"1":"0")' 2>/dev/null)
if [ "$HAS_PATHS" = "1" ]; then
  RUNNER="$TSX --test --test-reporter=tap"
  echo "  runner: tsx --test --test-reporter=tap (tsconfig paths present -- resolves @/ aliases)"
else
  RUNNER="$NODE --experimental-strip-types --test --test-reporter=tap"
  echo "  runner: node --experimental-strip-types --test --test-reporter=tap (no path aliases)"
fi

echo "=== target parses ==="
if "$NODE" '/Users/penn/bin/ts-mutator/ts-parse.mjs' 'lib/bfmrAutoLink.ts' 2>/tmp/_verify_parse.$$.log; then
  echo "  ok: lib/bfmrAutoLink.ts parses"
elif grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module) 'typescript'" /tmp/_verify_parse.$$.log; then
  echo "  WARN: ts-parse sidecar not installed (needs 'typescript' in bin/ts-mutator) -- relying on tsc --noEmit below"
else
  echo "  FAIL: lib/bfmrAutoLink.ts does not parse"; head -5 /tmp/_verify_parse.$$.log; fails=$((fails+1))
fi
rm -f /tmp/_verify_parse.$$.log

echo "=== types (tsc --noEmit) ==="
if $TSC --noEmit -p tsconfig.json >/tmp/_verify_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE 'lib/bfmrAutoLink\.ts[(:]' /tmp/_verify_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in lib/bfmrAutoLink.ts"; grep -E 'lib/bfmrAutoLink\.ts[(:]' /tmp/_verify_tsc.$$.log | head -15; fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE lib/bfmrAutoLink.ts (not this task's) -- passing type gate"
fi
rm -f /tmp/_verify_tsc.$$.log

echo "=== spec literals ==="
if python3 ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "=== behavioural tests ($RUNNER) ==="
# The adversarial cases live in the repo's OWN test file(s), authored by you and
# copied in -- the model is told not to edit them (SHA-checked like any fixture).
# `node --test` with ZERO tests exits 0 (green-on-nothing), so -- matching the
# Python/Swift `>= 3` discipline -- we also require >= 3 tests actually RAN, read
# from the count summary line. RUNNER forces `--test-reporter=tap` above so the
# line is the TAP `# tests N`; the grep also accepts the SPEC reporter's
# `ℹ tests N` as a belt-and-suspenders fallback should the reporter flag ever
# not take. The count keyword is anchored to a line-leading `# ` / `ℹ ` marker
# (never mid-line) so a test NAMED "... tests 5 ..." cannot false-match.
if [ -z "$TEST_FILES" ]; then
  echo "  SCAFFOLD_INCOMPLETE: no TEST_FILES set -- name the new/edited test file(s) in verify.sh"; fails=$((fails+1))
else
  _tout=$($RUNNER $TEST_FILES 2>&1); _trc=$?
  echo "$_tout" | tail -30
  _ntests=$(printf '%s
' "$_tout" | grep -oE '^(# |ℹ )tests [0-9]+' | grep -oE '[0-9]+' | tail -1)
  [ -z "$_ntests" ] && _ntests=0
  if [ "$_trc" -ne 0 ]; then
    echo "  FAIL: new test file(s) failed (exit $_trc)"; fails=$((fails+1))
  elif [ "$_ntests" -lt 3 ]; then
    echo "  SCAFFOLD_INCOMPLETE: only $_ntests test(s) ran; need >= 3 (a passing suite of 0 tests is vacuous)"; fails=$((fails+1))
  else
    echo "  ok: new test file(s) pass ($_ntests tests)"
  fi
fi

echo "=== repo suite (npm test, WARN-only) ==="
# A broader safety net. WARN not FAIL: a repo suite is often red at baseline for
# reasons this task never touched, so it cannot gate; the scoped TEST_FILES above
# are the authoritative behavioural pin. Set REPO_TEST=skip to silence.
if [ "${REPO_TEST:-run}" = "skip" ]; then
  echo "  (skipped)"
elif ! grep -q '"test"' package.json 2>/dev/null; then
  echo "  (no npm test script)"
elif npm test --silent >/tmp/_verify_npmtest.$$.log 2>&1; then
  echo "  ok: npm test green"
else
  echo "  WARN: npm test not green (may be pre-existing -- scoped tests above gate)"; tail -15 /tmp/_verify_npmtest.$$.log
fi
rm -f /tmp/_verify_npmtest.$$.log

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
