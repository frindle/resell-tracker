import test from 'node:test';
import assert from 'node:assert/strict';

import { isRestWrites, shouldRunWebBackfill } from './bfmrTransport.ts';

test('isRestWrites: rest in any case/whitespace is true', () => {
  assert.equal(isRestWrites('rest'), true);
  assert.equal(isRestWrites(' REST '), true);
});

test('isRestWrites: everything else is false', () => {
  for (const v of ['web', '', null, undefined, 'rest2']) {
    assert.equal(isRestWrites(v), false);
  }
});

test('shouldRunWebBackfill: REST writes skip the website login', () => {
  const base = { planRuns: true, needed: 15, restWrites: true, hasSidecarRows: false };
  assert.equal(shouldRunWebBackfill(base), false);
  assert.equal(shouldRunWebBackfill({ ...base, hasSidecarRows: true }), true);
  assert.equal(shouldRunWebBackfill({ ...base, restWrites: false }), true);
  assert.equal(shouldRunWebBackfill({ ...base, restWrites: false, needed: 0 }), false);
  assert.equal(shouldRunWebBackfill({ ...base, restWrites: false, planRuns: false }), false);
});
