// Adversarial fixture for: sync-status-overflow
//
// The fix is a Tailwind flex-truncation fix in inline JSX: the sync-job header
// row's LABEL span (the one rendering commandLabel(c.type)) has `truncate` but
// no `min-w-0`, so in its flex row (default min-width:auto) it cannot shrink --
// a long label pushes the ml-auto status word past the w-72 rounded box.
// Correct fix: give that span BOTH `min-w-0` AND `truncate`.
//
// A className is a plain string attribute (no enclosing single-brace { ... }
// JS expression to eval), so this asserts against the SOURCE TEXT rather than
// an eval'd expression. The ANCHOR extraction below is kept purely as an
// anchor-moved / anchor-not-unique HARD FAIL guard.

import * as fs from 'node:fs';

const TARGET = './components/SyncStatusIndicator.tsx';
const ANCHOR = "commandLabel(c.type)";   // a UNIQUE literal inside the label span

function assertAnchor(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor not found in ' + TARGET + ': ' + anchor);
  if (src.indexOf(anchor, at + anchor.length) >= 0)
    throw new Error('anchor is not unique in ' + TARGET + ': ' + anchor);
}

const SRC = fs.readFileSync(TARGET, 'utf8');
try {
  assertAnchor(SRC, ANCHOR);
} catch (e) {
  console.log('  FAIL - anchor guard: ' + e.message);
  process.exit(1);
}

// isolate the LABEL span (the element that renders commandLabel(c.type)) and
// capture its className. Accepts a "..." / '...' / `...` className. Throws if
// the label span isn't a <span> whose className immediately wraps
// {commandLabel(c.type)} -- so a wrong fix that restructures the element is caught.
function labelSpanClass(src) {
  const m = src.match(
    /<span\s+className=\{?\s*[`"']([^`"']*)[`"']\s*\}?\s*>\s*\{\s*commandLabel\(c\.type\)\s*\}\s*<\/span>/
  );
  if (!m) throw new Error('label span (className wrapping {commandLabel(c.type)}) not found -- was it restructured?');
  return m[1];
}

let fails = 0;
let checks = 0;
const chk = (name, cond) => {
  checks++;
  console.log((cond ? 'ok - ' : 'FAIL - ') + name);
  if (!cond) fails++;
};

let labelClass;
try {
  labelClass = labelSpanClass(SRC);
} catch (e) {
  console.log('  FAIL - label span extraction: ' + e.message);
  process.exit(1);
}
console.log('  label span className: ' + JSON.stringify(labelClass));

const has = (cls, tok) => new RegExp('(^|\\s)' + tok.replace(/-/g, '\\-') + '($|\\s)').test(cls);

// (1) DISCRIMINATOR -- fails at baseline (no min-w-0), passes after the fix.
chk('label span carries min-w-0 (so the flex child can shrink)', has(labelClass, 'min-w-0'));

// (2) REGRESSION GUARD -- truncate must remain (ellipsis within the box).
chk('label span still carries truncate', has(labelClass, 'truncate'));

// (3) OVER-TRIGGER GUARD -- the ml-auto status-word span must KEEP shrink-0.
chk('status-word span keeps `ml-auto shrink-0` (status must not shrink)',
    /className=\{`text-xs ml-auto shrink-0 /.test(SRC));

// (4) STRUCTURE GUARD -- the label span must still live in the flex header row.
chk('header row is still `flex items-center gap-2`', /className="flex items-center gap-2"/.test(SRC));

if (checks < 3) {
  console.log('  SCAFFOLD_INCOMPLETE: only ' + checks + ' chk() case(s); need >= 3.');
  process.exit(1);
}
console.log('--- ' + fails + ' failed ---');
process.exit(fails === 0 ? 0 : 1);
