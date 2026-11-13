import test from 'node:test';
import assert from 'node:assert/strict';
import { setAttachmentCards, type PhotoCardDeps } from './photoCardLinks.ts';

function setup() {
  const calls: [number, number[], number | null][] = [];
  const deps: PhotoCardDeps = {
    orderCardIds: async oid => (oid === 1 ? [10, 11, 12] : [20]),
    replace: async (a, ids, first) => { calls.push([a, ids, first]); },
  };
  return { deps, calls };
}

test('sets several cards and the first becomes giftCardId', async () => {
  const { deps, calls } = setup();
  const r = await setAttachmentCards(deps, 5, 1, [11, 10, 11]);
  assert.deepEqual(r, { ok: true, giftCardIds: [11, 10] });
  assert.deepEqual(calls, [[5, [11, 10], 11]]);
});

test('empty array unlinks (giftCardId null)', async () => {
  const { deps, calls } = setup();
  await setAttachmentCards(deps, 5, 1, []);
  assert.deepEqual(calls, [[5, [], null]]);
});

test('a card from another order is rejected and nothing is written', async () => {
  const { deps, calls } = setup();
  const r = await setAttachmentCards(deps, 5, 1, [10, 20]);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('non-integer input is rejected', async () => {
  const { deps } = setup();
  assert.equal((await setAttachmentCards(deps, 5, 1, 'x')).ok, false);
  assert.equal((await setAttachmentCards(deps, 5, 1, [1.5])).ok, false);
});
