import test from 'node:test';
import assert from 'node:assert/strict';

import { isRestWrites } from './bfmrTransport.ts';

test('isRestWrites: rest in any case/whitespace is true', () => {
  assert.equal(isRestWrites('rest'), true);
  assert.equal(isRestWrites(' REST '), true);
});

test('isRestWrites: everything else is false', () => {
  for (const v of ['web', '', null, undefined, 'rest2']) {
    assert.equal(isRestWrites(v), false);
  }
});
