/**
 * ASIN-aware item matching in the package matcher. All data is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPackages, itemNamesAgree, itemMatchesLine, type PackageIn, type ReservationLineIn } from './bfmrPackageMatch.ts';

const ORDER = '111-0000000-0000001';
const NAME = 'Amazon - Echo Spot - Black - B0BFC7WQ6R';

function pkg(items: PackageIn['items']): PackageIn {
  return { orderId: 1, orderNumber: ORDER, trackingNumber: 'TBA000000000001', itemsKnown: true, items };
}
function res(over: Partial<ReservationLineIn> = {}): ReservationLineIn {
  return {
    id: 10, reserveId: 'R10', bfmrOrderId: ORDER, itemName: NAME, dealTitle: null, qty: 4, status: 'purchased',
    trackingNumber: null, submitted: [], links: [{ orderId: 1, quantity: 4, trackingNumber: null }],
    ...over,
  };
}

test('a BFMR name ending in the ASIN no longer fails the digit-word rule', () => {
  assert.equal(itemNamesAgree('Amazon Echo Spot (newest model) smart alarm clock, Black', NAME), true);
  assert.equal(itemMatchesLine({ title: 'Amazon Echo Spot smart alarm clock, Black', quantity: 4 }, { itemName: NAME, dealTitle: null }), true);
});

test('equal ASINs match even when the words differ; different ASINs never match', () => {
  const line = { itemName: NAME, dealTitle: null };
  assert.equal(itemMatchesLine({ title: 'Totally different wording', asin: 'b0bfc7wq6r', quantity: 1 }, line), true);
  assert.equal(itemMatchesLine({ title: 'Amazon Echo Spot smart alarm clock Black', asin: 'B0AAAAAAAA', quantity: 1 }, line), false);
});

test('the ASIN in the deal title decides when the item name has none', () => {
  const line = { itemName: 'Echo Spot', dealTitle: 'Echo Spot deal B0BFC7WQ6R' };
  assert.equal(itemMatchesLine({ title: 'Something else', asin: 'B0BFC7WQ6R', quantity: 1 }, line), true);
  assert.equal(itemMatchesLine({ title: 'Something else', asin: 'B0ZZZZZZZZ', quantity: 1 }, line), false);
});

test('Echo Spot x4 in one package with the ASIN on the BFMR name -> exact qty 4', () => {
  const r = res();
  const [d] = matchPackages([pkg([{ title: 'Amazon Echo Spot smart alarm clock, Black', asin: 'B0BFC7WQ6R', quantity: 4 }])], [r]);
  assert.equal(d.decision, 'exact');
  assert.deepEqual(d.allocations, [{ reservationId: 10, qty: 4 }]);
  // no ASIN on the package item: the words decide, with the ASIN dropped from the BFMR side
  const [d2] = matchPackages([pkg([{ title: 'Amazon Echo Spot smart alarm clock, Black', quantity: 4 }])], [r]);
  assert.equal(d2.decision, 'exact');
});

test('other digit-word rules still hold when an ASIN is present', () => {
  assert.equal(itemNamesAgree('Acme Widget Pro 512GB Graphite Edition', 'Acme Widget Pro 256GB B0BFC7WQ6R'), false);
});
