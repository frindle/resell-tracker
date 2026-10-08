import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSyncGuard } from './bgSyncGuard.ts';

test('0 from BG over stored rows is refused with 502 and the real count', async () => {
  for (const n of [1, 5]) {
    const res = checkSyncGuard(0, n)!;
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, new RegExp(`${n} are stored`));
  }
});
test('every other combination passes', () => {
  for (const [bg, stored] of [[0, 0], [1, 0], [1, 3]]) assert.equal(checkSyncGuard(bg, stored), null);
});
