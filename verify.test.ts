// Adversarial repo-style test for: bfmr-relink-v3   (node --test / tsx --test)
//
// >>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<
// The single guard case below FAILS (SCAFFOLD_INCOMPLETE) until you author >= 3 real cases
// and delete it. A generator can emit a test that DISCRIMINATES; it cannot
// decide whether it is RELEVANT to the property the task asked for.
//
// This is a REAL repo test, run by verify.sh under `node --test` (or `tsx
// --test` when the repo uses `@/` path aliases -- verify.sh picks the runner).
// Import the target the way the repo does:
//   import { theFn } from './lib/bfmrAutoLink';      // relative
//   import { theFn } from '@/lib/whatever';         // path alias (needs tsx runner)
//
// Author inputs that separate "did the job" from "made the test go green":
//   - the boundary, and one input on each side of it;
//   - the degenerate inputs (null / missing / wrong type) that must NOT throw;
//   - at least one input a plausible WRONG fix gets wrong; and
//   - >>> an OVER-TRIGGER GUARD <<< : proof the change does NOT fire when it
//     must not. A one-directional fix that breaks the other direction is the
//     single most common wrong fix; pin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// import { theFn } from './lib/bfmrAutoLink';   // <-- wire this to the real symbol

// >>> DRAFTED-CASES (auto-injected) >>>
// Model-drafted; NOT yet read by a human.
const DRAFT_UNCONFIRMED = true;
import * as mod from './lib/bfmrAutoLink.ts';
test('relinkStaleBfmrLinks is exported as a function', () => {
  assert.equal(typeof (mod as any).relinkStaleBfmrLinks, 'function');
});
test('relinkStaleBfmrLinks accepts a userId argument', () => {
  assert.ok((mod as any).relinkStaleBfmrLinks && (mod as any).relinkStaleBfmrLinks.length >= 1);
});
test('autoLinkBfmrReservations remains exported (regression)', () => {
  assert.equal(typeof (mod as any).autoLinkBfmrReservations, 'function');
});
// <<< DRAFTED-CASES <<<
