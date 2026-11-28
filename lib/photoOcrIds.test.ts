import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePhotoIds } from './photoOcrIds.ts';

test('one to 50 positive integers are accepted', () => {
  assert.deepEqual(parsePhotoIds([7]), { ok: true, ids: [7] });
  assert.deepEqual(parsePhotoIds([1, 2, 3]), { ok: true, ids: [1, 2, 3] });
  assert.equal(parsePhotoIds(Array.from({ length: 50 }, (_, i) => i + 1)).ok, true);
});

test('repeated ids are queued once', () => {
  assert.deepEqual(parsePhotoIds([4, 5, 4]), { ok: true, ids: [4, 5] });
});

test('anything else is refused with a short error', () => {
  const bads: unknown[] = [undefined, null, 5, '1', {}, [], Array.from({ length: 51 }, (_, i) => i + 1),
    [0], [-1], [1.5], ['1'], [NaN], [Infinity], [null], [1, 'x'], [2 ** 60]];
  for (const bad of bads) {
    const r = parsePhotoIds(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.length > 0 && r.error.length < 60);
  }
});
