// Adversarial repo-style test for: rt-bfmr-pending-sync-scope-s2-export-function-parsebfm   (node --test / tsx --test)
//
// Contract under test: parseBfmrSyncScope(raw: unknown): BfmrSyncScope, where
// BfmrSyncScope = 'all' | 'pending'. The two canonical strings pass through
// unchanged; EVERYTHING else (null/undefined/wrong type/garbage/case-variant/
// padded) falls back to the default 'all'. It must never throw on untrusted
// input. A plausible-but-wrong fix that accepts case-insensitive or trimmed
// values, or defaults to 'pending', is caught below.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBfmrSyncScope } from './lib/bfmrSyncScope';

test('canonical scopes pass through unchanged (both directions)', () => {
  assert.equal(parseBfmrSyncScope('all'), 'all');
  assert.equal(parseBfmrSyncScope('pending'), 'pending');
});

test('degenerate inputs fall back to the default and never throw', () => {
  for (const raw of [undefined, null, 0, 42, true, {}, [], Symbol('x')]) {
    assert.equal(parseBfmrSyncScope(raw), 'all', `raw=${String(raw)}`);
  }
});

test('garbage strings fall back to the default (no over-trigger)', () => {
  for (const raw of ['', ' ', 'ALL', 'Pending', 'All', ' pending', 'pending ', 'pendinng', 'all,pending']) {
    assert.equal(parseBfmrSyncScope(raw), 'all', `raw=${JSON.stringify(raw)}`);
  }
});

test('result is always one of the two canonical strings, exactly', () => {
  const out = parseBfmrSyncScope(Math.random() < 0.5 ? 'pending' : 'nope');
  assert.ok(out === 'all' || out === 'pending', `unexpected scope: ${String(out)}`);
});
