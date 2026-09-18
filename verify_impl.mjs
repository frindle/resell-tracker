// Adversarial expression-extraction fixture for: bfmr-sync-reservations-500-guard
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is guarded off (CASES_AUTHORED = false) and this verify FAILS
// (SCAFFOLD_INCOMPLETE) until you author >= 3 real cases below and flip it. Deliberate: a
// generator can emit a verify that DISCRIMINATES (red at baseline, green on a
// fix); it cannot decide whether the verify is RELEVANT -- whether it tests the
// property the task asked for. A benign case passes broken work.
//
// HOW THIS WORKS (no import): it reads app/api/bfmr/sync-reservations/route.ts as text, finds the unique
// ANCHOR literal, captures the enclosing single-brace { ... } JS expression,
// and builds `new Function(...PARAMS)` from its body. That reaches inline JSX /
// a config or object literal / a ternary that no module exports.
//
// LIMIT: the brace matcher is depth-counting and NOT string-aware -- an
// expression whose own string/template literals contain a literal { or } will
// mis-slice. Anchor on an expression without braces-in-strings (the common
// case), or extend extractExpr to skip quoted spans.
//
// Author inputs that separate "did the job" from "made the test go green":
//   - the boundary, and one input on each side of it;
//   - the degenerate inputs (missing key / wrong type) that must NOT throw;
//   - at least one input a plausible WRONG fix would get wrong; and
//   - >>> an OVER-TRIGGER GUARD <<< : a case proving the change does NOT fire
//     when it must not (the input that must keep the OLD branch). A
//     one-directional fix that breaks the opposite direction is the single most
//     common wrong fix; pin it.

import * as fs from 'node:fs';

const TARGET = './app/api/bfmr/sync-reservations/route.ts';
const ANCHOR = "try {\n    return await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));";   // a UNIQUE literal that sits INSIDE the target expression

// --- extraction: the enclosing { ... } around the anchor, brace-balanced ----
function extractExpr(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor not found in ' + TARGET + ': ' + anchor);
  if (src.indexOf(anchor, at + anchor.length) >= 0)
    throw new Error('anchor is not unique in ' + TARGET + ': ' + anchor);
  // walk BACK to the { that opens the enclosing group (brace-depth aware)
  let i = at, depth = 0;
  for (; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) break; depth--; }
  }
  if (i < 0) throw new Error('no enclosing { before anchor in ' + TARGET);
  // walk FORWARD to its matching }
  let j = i, d = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') d++;
    else if (c === '}') { if (--d === 0) break; }
  }
  if (j >= src.length) throw new Error('no matching } after anchor in ' + TARGET);
  return src.slice(i + 1, j).trim();
}

const SRC = fs.readFileSync(TARGET, 'utf8');
let EXPR;
try {
  EXPR = extractExpr(SRC, ANCHOR);
} catch (e) {
  // Extraction failure is a hard FAIL, never a skip: if the anchor moved or the
  // braces do not balance, the verify certifies nothing and must say so.
  console.log('  FAIL - extraction: ' + e.message);
  process.exit(1);
}

// --- the parameters the expression reads. AUTHOR THIS to match the target. ---
// Order matters: evalExpr(...args) binds positionally to these names.
// NOTE: the captured EXPR is a try/catch STATEMENT block (not a single
// expression) containing `await`, so it must run as the BODY of an async
// function -- the plain Function constructor cannot produce one, so we use
// the AsyncFunction constructor instead, and do NOT wrap EXPR in `return(...)`.
const PARAMS = ['filters', 'creds', 'getMyTrackerAll'];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function evalExpr(...args) {
  const fn = new AsyncFunction(...PARAMS, EXPR);   // eslint-disable-line no-new-func
  return fn(...args);
}

let fails = 0;
let checks = 0;
const chk = (name, cond) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

const isBfmrError = (r) => r && typeof r === 'object' && r.__bfmrError === true;

const CASES_AUTHORED = true;
if (!CASES_AUTHORED) {
  console.log('  SCAFFOLD_INCOMPLETE: adversarial cases not yet authored in verify_impl.mjs.');
  console.log('  extracted expression was: ' + EXPR);
  process.exit(1);
}

async function main() {
  // 1) success path: shape + order preserved (regression guard)
  {
    const filters = [{ status: 'a' }, { status: 'b' }];
    const getMyTrackerAll = async (_creds, f) => [f.status];
    const r = await evalExpr(filters, { apiKey: 'k' }, getMyTrackerAll);
    chk('success: array-of-arrays in filter order, no error wrapper',
        Array.isArray(r) && JSON.stringify(r) === JSON.stringify([['a'], ['b']]) && !isBfmrError(r));
  }

  // 2) rejected fetch (e.g. expired/invalid key) -> 502 with the underlying message surfaced
  {
    const filters = [{ status: 'x' }];
    const getMyTrackerAll = async () => { throw new Error('BFMR 401: invalid key'); };
    const r = await evalExpr(filters, { apiKey: 'k' }, getMyTrackerAll);
    chk('auth failure caught -> 502, message names BOTH "BFMR fetch failed" and the underlying error',
        isBfmrError(r) && r.status === 502 &&
        r.message.includes('BFMR fetch failed') && r.message.includes('BFMR 401: invalid key'));
  }

  // 3) timeout-style rejection -> same 502 shape, underlying text still visible (not genericized)
  {
    const filters = [{ status: 'x' }];
    const getMyTrackerAll = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const r = await evalExpr(filters, { apiKey: 'k' }, getMyTrackerAll);
    chk('30s-timeout-style rejection caught -> 502, underlying "aborted due to timeout" text preserved',
        isBfmrError(r) && r.status === 502 && r.message.includes('aborted due to timeout'));
  }

  // 4) over-trigger guard: one of several filters rejects -- Promise.all all-or-nothing must
  //    still be caught as a whole failure, never silently reported as a partial success array.
  {
    const filters = [{ status: 'ok' }, { status: 'bad' }];
    const getMyTrackerAll = async (_creds, f) => {
      if (f.status === 'bad') throw new Error('BFMR 500: server error');
      return [f.status];
    };
    const r = await evalExpr(filters, { apiKey: 'k' }, getMyTrackerAll);
    chk('mixed fan-out (one filter fails) -> whole call caught as 502, not a partial-success array',
        isBfmrError(r) && r.status === 502 && r.message.includes('BFMR 500: server error'));
  }

  // 5) regression guard: creds are still forwarded through unchanged on the success path
  {
    const filters = [{ status: 'x' }];
    const getMyTrackerAll = async (creds, f) => {
      if (creds.apiKey !== 'k1') throw new Error('wrong creds forwarded: ' + JSON.stringify(creds));
      return [f.status];
    };
    const r = await evalExpr(filters, { apiKey: 'k1' }, getMyTrackerAll);
    chk('creds still forwarded to getMyTrackerAll unchanged (regression guard)',
        Array.isArray(r) && JSON.stringify(r) === JSON.stringify([['x']]));
  }

  // Structural floor -- matches the Python/Swift `>= 3` discipline.
  if (checks < 3) {
    console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
    process.exit(1);
  }
  console.log('--- ' + fails + ' failed ---');
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  FAIL - uncaught exception running cases: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
