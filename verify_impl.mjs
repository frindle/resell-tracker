// Behavioural fixture for: rt-order-buyerid-patchable
//
// No import (the PATCH handler needs NextRequest+prisma+auth). Instead this
// reads app/api/orders/[id]/route.ts as TEXT and behaviourally exercises what
// the fix must do:
//   (A) 'buyerId' is a member of the REAL PATCHABLE_FIELDS Set, so it survives
//       the route's own filter loop into `data` (the persistence property --
//       the exact defect: without membership the field is dropped silently).
//   (B) buyerId is COERCED to Int/null like cardId (:234-236), GUARDED by
//       `if ('buyerId' in data)` so an unrelated PATCH does NOT unassign it:
//       '7'->7, '12'->12, ''->null, null->null, and ABSENT -> untouched.
// Both are evaluated from the model's ACTUAL source text, not asserted by grep.

import * as fs from 'node:fs';

const TARGET = './app/api/orders/[id]/route.ts';
const SRC = fs.readFileSync(TARGET, 'utf8');

let fails = 0, checks = 0;
const chk = (name, cond) => { checks++; console.log((cond ? 'ok - ' : 'FAIL - ') + name); if (!cond) fails++; };

// ---- (A) extract the real PATCHABLE_FIELDS Set and drive the real filter ----
const setM = SRC.match(/PATCHABLE_FIELDS\s*=\s*new\s+Set\(\s*(\[[\s\S]*?\])\s*\)/);
if (!setM) { console.log('  FAIL - could not locate PATCHABLE_FIELDS = new Set([...])'); process.exit(1); }
let PATCHABLE;
try { PATCHABLE = new Set(new Function('return (' + setM[1] + ');')()); } // eslint-disable-line no-new-func
catch (e) { console.log('  FAIL - PATCHABLE_FIELDS array did not eval: ' + e.message); process.exit(1); }

chk('buyerId is a member of PATCHABLE_FIELDS (persistence)', PATCHABLE.has('buyerId'));
chk('cardId still a member (regression guard)', PATCHABLE.has('cardId'));
chk('a non-patchable field (userId) is NOT allowed (over-trigger guard)', !PATCHABLE.has('userId'));
chk('a non-patchable field (id) is NOT allowed (over-trigger guard)', !PATCHABLE.has('id'));

// drive the route's own filter contract behaviourally
const body = { buyerId: '5', cost: '10', bogusField: 'x' };
const data0 = {};
for (const k of Object.keys(body)) if (PATCHABLE.has(k)) data0[k] = body[k];
chk('filter keeps buyerId in data (a PATCH with buyerId persists it)', 'buyerId' in data0);
chk('filter keeps a known field (cost)', 'cost' in data0);
chk('filter drops an unknown field (bogusField)', !('bogusField' in data0));

// ---- (B) extract the GUARDED buyerId coercion block and evaluate it ----------
// Capture `if ('buyerId' in data) { ... }` (balanced braces) so both the guard
// AND the coercion are exercised. Strip TS `as T` casts so node can eval it.
function extractGuardBlock(src) {
  const gm = src.match(/if\s*\(\s*['"]buyerId['"]\s+in\s+data\s*\)\s*\{/);
  if (!gm) return null;
  const start = gm.index;
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}
const block = extractGuardBlock(SRC);
if (!block) {
  console.log("  FAIL - no `if ('buyerId' in data) { data.buyerId = ... }` coercion block found");
  fails++;
} else {
  const clean = block.replace(/\s+as\s+[A-Za-z0-9_.<>\[\]]+/g, '');
  let run;
  try { run = new Function('data', clean + '\nreturn data;'); } // eslint-disable-line no-new-func
  catch (e) { console.log('  FAIL - guarded coercion block did not eval: ' + e.message); fails++; run = null; }
  if (run) {
    chk("coerce '7' -> 7 (numeric string -> int)", run({ buyerId: '7' }).buyerId === 7);
    chk("coerce '12' -> 12", run({ buyerId: '12' }).buyerId === 12);
    chk("coerce '' -> null (explicit unassign)", run({ buyerId: '' }).buyerId === null);
    chk('coerce null -> null (explicit unassign)', run({ buyerId: null }).buyerId === null);
    // OVER-TRIGGER GUARD: buyerId not in the patch must NOT be added/unassigned.
    chk('buyerId ABSENT -> not touched (guard prevents accidental unassign)', !('buyerId' in run({ cost: '5' })));
  }
}

if (checks < 3) { console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.'); process.exit(1); }
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
