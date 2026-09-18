// Adversarial expression-extraction fixture for: sync-status-drag-resize
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
//
// The case list is guarded off (CASES_AUTHORED = false) and this verify FAILS
// (SCAFFOLD_INCOMPLETE) until you author >= 3 real cases below and flip it. Deliberate: a
// generator can emit a verify that DISCRIMINATES (red at baseline, green on a
// fix); it cannot decide whether the verify is RELEVANT -- whether it tests the
// property the task asked for. A benign case passes broken work.
//
// HOW THIS WORKS (no import): it reads components/SyncStatusIndicator.tsx as text, finds the unique
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

const TARGET = './components/SyncStatusIndicator.tsx';
// Anchored just inside the OUTER object literal (right after its opening `{`), so the
// backward brace-walk lands on the outer `{` rather than the inner `${...}` template
// interpolations (which are their own balanced brace pairs and would mis-anchor otherwise).
const ANCHOR = "left: `${position.x}px`, top: `${position.y}px`";

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
// NOTE: the captured EXPR is the OBJECT LITERAL BODY (braces excluded by the extractor),
// e.g. `left: ..., top: ...` -- not a standalone expression -- so we re-wrap it in `{ }`
// ourselves before evaluating, to get the actual style object back.
const PARAMS = ['position'];
function evalExpr(...args) {
  const fn = new Function(...PARAMS, 'return ({' + EXPR + '});');   // eslint-disable-line no-new-func
  return fn(...args);
}

let fails = 0;
let checks = 0;
const chk = (name, cond) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

// --- adversarial cases -- AUTHOR THESE, then flip CASES_AUTHORED to true ------
// Example (from the Tesla caption case):
//   chk('tesla, non-interactive -> tesla app',
//       evalExpr({ctrl: 'full'}, false) === 'SET IN TESLA APP');
//   chk('rivian, non-interactive -> rivian app (over-trigger guard)',
//       evalExpr({ctrl: 'schedule'}, false) === 'SET VIA RIVIAN APP');
//   chk('interactive -> dial prompt regardless of make',
//       evalExpr({ctrl: 'full'}, true) === 'TAP DIAL TO SET');

chk('left/top still computed from position.x/position.y in px (regression guard)',
    (() => { const s = evalExpr({ x: 120, y: 340 }); return s.left === '120px' && s.top === '340px'; })());

chk('right neutralized to auto -- stops the bottom-4/right-4 CSS class from anchoring the right edge (core fix)',
    evalExpr({ x: 120, y: 340 }).right === 'auto');

chk('bottom neutralized to auto -- stops the CSS class from constraining height between top and bottom (core fix)',
    evalExpr({ x: 120, y: 340 }).bottom === 'auto');

chk('neutralization holds at the x=0,y=0 boundary, not only for position values > 0',
    (() => { const s = evalExpr({ x: 0, y: 0 }); return s.left === '0px' && s.top === '0px' && s.right === 'auto' && s.bottom === 'auto'; })());

chk('over-trigger guard: right/bottom stay auto for a large/negative position, not conditioned on magnitude or sign',
    (() => { const s = evalExpr({ x: 9999, y: -50 }); return s.right === 'auto' && s.bottom === 'auto' && s.left === '9999px' && s.top === '-50px'; })());

const CASES_AUTHORED = true;
if (!CASES_AUTHORED) {
  console.log('  SCAFFOLD_INCOMPLETE: adversarial cases not yet authored in verify_impl.mjs.');
  console.log('  extracted expression was: ' + EXPR);
  process.exit(1);
}

// Structural floor -- matches the Python/Swift `>= 3` discipline. Flipping
// CASES_AUTHORED with zero chk() calls would otherwise leave fails=0 and go
// green (a vacuous verify). Count and fail short of 3.
if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
