import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAcceptedCodes, type ApplyDeps } from './giftCardOcrApply.ts';

// Made-up data. Attachments 1 and 2 are on this order; 99 is on another order.
function setup() {
  const links: [number, number][] = [];
  const cards: { id: number }[] = [];
  const attachments = new Map<number, { id: number; giftCardId: number | null }>([[1, { id: 1, giftCardId: null }], [2, { id: 2, giftCardId: null }]]);
  const deps: ApplyDeps = {
    existingNumbers: async () => [],
    findAttachment: async id => attachments.get(id) ?? null,
    createCard: async () => { const c = { id: cards.length + 10 }; cards.push(c); return c; },
    linkAttachment: async (a, c) => { links.push([a, c]); },
  };
  return { deps, links, cards };
}
const code = (n: string, attachmentId?: number) => ({ cardNumber: n, merchant: 'Acme', value: 25, attachmentId });

test('accepted code links its source photo to the new card', async () => {
  const { deps, links } = setup();
  const r = await applyAcceptedCodes(deps, [code('1111222233334444', 1)]);
  assert.equal(r.created.length, 1);
  assert.deepEqual(links, [[1, 10]]);
});

test('another order\'s attachment is rejected: no card, no link', async () => {
  const { deps, links, cards } = setup();
  const r = await applyAcceptedCodes(deps, [code('1111222233334444', 99)]);
  assert.equal(r.created.length, 0);
  assert.equal(cards.length, 0);
  assert.equal(links.length, 0);
  assert.match(r.skipped[0].reason, /photo/);
});

test('no attachmentId behaves as before; a photo yielding two codes links to both', async () => {
  const { deps, links } = setup();
  const r = await applyAcceptedCodes(deps, [code('1111222233334444'), code('5555666677778888', 2), code('9999000011112222', 2)]);
  assert.equal(r.created.length, 3);
  assert.deepEqual(links, [[2, 11], [2, 12]]);
});
