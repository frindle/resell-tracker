import test from 'node:test';
import assert from 'node:assert/strict';
import { bigSkyLinkTotal, decideBigSkySalePrice, type BigSkyOrderState } from './bigskySalePrice.ts';

const open: BigSkyOrderState = {
  salePrice: null, bgExpectedPayout: null, salePriceSynced: false, cancelled: false, locked: false, bgCredited: false,
};

test('total is dealPrice × quantity summed over links, to the cent', () => {
  assert.equal(bigSkyLinkTotal([{ dealPrice: 412.5, quantity: 2 }, { dealPrice: 19.99, quantity: 3 }]), 884.97);
  assert.equal(bigSkyLinkTotal([{ dealPrice: 0.1, quantity: 3 }]), 0.3);
  assert.equal(bigSkyLinkTotal([]), 0);
});

test('linking an unpriced order sets salePrice and expected payout', () => {
  assert.deepEqual(decideBigSkySalePrice(open, [{ dealPrice: 250, quantity: 2 }]),
    { action: 'write', salePrice: 500, bgExpectedPayout: 500 });
});

test('linking by hand replaces an existing price, even on a locked order', () => {
  const o = { ...open, salePrice: 480, locked: true };
  assert.deepEqual(decideBigSkySalePrice(o, [{ dealPrice: 250, quantity: 2 }]),
    { action: 'write', salePrice: 500, bgExpectedPayout: 500 });
});

test('changing the quantity reprices', () => {
  const o = { ...open, salePrice: 250, bgExpectedPayout: 250 };
  assert.deepEqual(decideBigSkySalePrice(o, [{ dealPrice: 250, quantity: 3 }]),
    { action: 'write', salePrice: 750, bgExpectedPayout: 750 });
});

test('paid, scanned and cancelled orders keep their price', () => {
  const links = [{ dealPrice: 250, quantity: 1 }];
  assert.deepEqual(decideBigSkySalePrice({ ...open, salePriceSynced: true, salePrice: 245 }, links), { action: 'skip', reason: 'paid' });
  assert.deepEqual(decideBigSkySalePrice({ ...open, bgCredited: true }, links), { action: 'skip', reason: 'scanned' });
  assert.deepEqual(decideBigSkySalePrice({ ...open, cancelled: true }, links), { action: 'skip', reason: 'cancelled' });
});

test('already at the link total: nothing to write', () => {
  const o = { ...open, salePrice: 250, bgExpectedPayout: 250.001 };
  assert.deepEqual(decideBigSkySalePrice(o, [{ dealPrice: 250, quantity: 1 }]), { action: 'skip', reason: 'unchanged' });
});

test('background backfill: fills empty prices and follows a deal price change, skips locked and typed prices', () => {
  const links = [{ dealPrice: 260, quantity: 1 }];
  const bg = { respectLock: true };
  assert.deepEqual(decideBigSkySalePrice(open, links, bg), { action: 'write', salePrice: 260, bgExpectedPayout: 260 });
  assert.deepEqual(decideBigSkySalePrice({ ...open, salePrice: 250, bgExpectedPayout: 250 }, links, bg),
    { action: 'write', salePrice: 260, bgExpectedPayout: 260 });
  assert.deepEqual(decideBigSkySalePrice({ ...open, locked: true }, links, bg), { action: 'skip', reason: 'locked' });
  assert.deepEqual(decideBigSkySalePrice({ ...open, salePrice: 240 }, links, bg), { action: 'skip', reason: 'user-price' });
});

test('removing the last link clears only the price the links set', () => {
  const o = { ...open, salePrice: 500, bgExpectedPayout: 500 };
  assert.deepEqual(decideBigSkySalePrice(o, [], { previousTotal: 500 }),
    { action: 'write', salePrice: null, bgExpectedPayout: null });
  // the user typed a different price after linking: it stays, the payout clears
  assert.deepEqual(decideBigSkySalePrice({ ...o, salePrice: 480 }, [], { previousTotal: 500 }),
    { action: 'write', salePrice: 480, bgExpectedPayout: null });
  assert.deepEqual(decideBigSkySalePrice({ ...open, salePrice: 480 }, [], { previousTotal: 500 }),
    { action: 'skip', reason: 'not-link-price' });
  assert.deepEqual(decideBigSkySalePrice(o, [], {}), { action: 'skip', reason: 'unchanged' });
});

test('removing one of two links reprices to the one left', () => {
  const o = { ...open, salePrice: 600, bgExpectedPayout: 600 };
  assert.deepEqual(decideBigSkySalePrice(o, [{ dealPrice: 100, quantity: 1 }], { previousTotal: 600 }),
    { action: 'write', salePrice: 100, bgExpectedPayout: 100 });
});
