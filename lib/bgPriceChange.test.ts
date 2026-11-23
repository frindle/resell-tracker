import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBgPriceChange, parseBgWhen, repriceSkip, belowCostBy, previewSale, alertChange, termsAfter, sameTerms,
  priceChangeText, priceNoteLine, alertText, anyUnderCost, type RepriceResult,
} from './bgPriceChange.ts';

const SUBJECT = 'Commitment Price Change Scheduled';

// Shaped like the real notice: an HTML body in the text part, BuyingGroup's
// "comission" spelling, and a Django-style date with the sentence's own period.
const HTML_BODY = `<html><body><table><tr><td>
<p>Hi Sam,</p>
<p>Price change scheduled on: CM-1000000001,<br>
New price will be: 599.00<br>
New comission will be: 2.00<br>
On Nov. 23, 2026, 4 a.m..</p>
<p>Please login and click on "My Commitments" to review.</p>
</td></tr></table></body></html>`;

test('parses the real notice shape: id, price, misspelled commission, date', () => {
  assert.deepEqual(parseBgPriceChange(SUBJECT, HTML_BODY), {
    commitmentId: 'CM-1000000001', price: 599, commission: 2, when: 'Nov. 23, 2026, 4 a.m.',
    effectiveAt: '2026-11-23T04:00:00.000Z',
  });
});

test('plain text, a correctly spelled commission and thousands separators', () => {
  const body = 'Price change scheduled on: CM-2000000002\nNew price will be: $1,249.50\nNew commission will be: 0.00\nOn Dec. 1, 2026, 4:30 p.m.\n';
  const p = parseBgPriceChange('Fwd: Commitment Price Change Scheduled', body);
  assert.equal(p?.commitmentId, 'CM-2000000002');
  assert.equal(p?.price, 1249.5);
  assert.equal(p?.commission, 0);
  assert.equal(p?.effectiveAt, '2026-12-01T16:30:00.000Z');
});

test('no commission line keeps the commitment its own; no date leaves the time unknown', () => {
  const p = parseBgPriceChange(SUBJECT, 'Price change scheduled on: CM-3000000003, New price will be: 10.00');
  assert.equal(p?.commission, null);
  assert.equal(p?.effectiveAt, null);
  assert.equal(p?.when, '');
  assert.deepEqual(termsAfter({ price: 10, commission: null }, { price: 12, commission: 1.5 }), { price: 10, commission: 1.5 });
});

test('other BuyingGroup mail and notices missing the id or price are not price changes', () => {
  assert.equal(parseBgPriceChange('Your Commitment Has Been Affected - Deal Expired', HTML_BODY), null);
  assert.equal(parseBgPriceChange(SUBJECT, 'New price will be: 599.00'), null);
  assert.equal(parseBgPriceChange(SUBJECT, 'Price change scheduled on: CM-1000000001,'), null);
});

test('when: noon, midnight, 12 a.m., p.m., date only, junk', () => {
  assert.equal(parseBgWhen('Nov. 23, 2026, noon'), '2026-11-23T12:00:00.000Z');
  assert.equal(parseBgWhen('Nov. 23, 2026, midnight'), '2026-11-23T00:00:00.000Z');
  assert.equal(parseBgWhen('Nov. 23, 2026, 12 a.m.'), '2026-11-23T00:00:00.000Z');
  assert.equal(parseBgWhen('Nov. 23, 2026, 12 p.m.'), '2026-11-23T12:00:00.000Z');
  assert.equal(parseBgWhen('November 3, 2026, 11 p.m.'), '2026-11-03T23:00:00.000Z');
  assert.equal(parseBgWhen('Sept. 9, 2026'), '2026-09-09T00:00:00.000Z');
  assert.equal(parseBgWhen('soon'), null);
});

test('paid, credited, cancelled and locked orders keep their sale price', () => {
  const base = { locked: false, cancelled: false, salePriceSynced: false, bgCredited: false, bgPaidAmount: null };
  assert.equal(repriceSkip(base), null);
  assert.equal(repriceSkip({ ...base, bgPaidAmount: 0 }), null);
  assert.equal(repriceSkip({ ...base, cancelled: true, locked: true }), 'cancelled');
  assert.equal(repriceSkip({ ...base, salePriceSynced: true }), 'paid');
  assert.equal(repriceSkip({ ...base, bgCredited: true }), 'paid');
  assert.equal(repriceSkip({ ...base, bgPaidAmount: 50 }), 'paid');
  assert.equal(repriceSkip({ ...base, locked: true }), 'locked');
});

const money = { cost: 1198, shippingCost: 0, insuranceCost: 0, returnedCost: 0, cashbackAmount: 0, portalCashback: null };

test('below cost counts shipping, insurance and returns, not cashback', () => {
  assert.equal(belowCostBy({ ...money, salePrice: 1202 }), 0);
  assert.equal(belowCostBy({ ...money, salePrice: 1198 }), 0);
  assert.equal(belowCostBy({ ...money, salePrice: 1150 }), 48);
  assert.equal(belowCostBy({ ...money, salePrice: 1198, shippingCost: 10, insuranceCost: 2 }), 12);
  assert.equal(belowCostBy({ ...money, salePrice: 599, returnedCost: 599 }), 0);
  assert.equal(belowCostBy({ ...money, salePrice: 1150, cashbackAmount: 60 }), 48);
  assert.equal(belowCostBy({ ...money, salePrice: null }), 0);
});

test('preview moves the sale by the unit change times the units sold', () => {
  assert.equal(previewSale(1198, 2, { price: 597, commission: 2 }, { price: 599, commission: 2 }), 1202);
  assert.equal(previewSale(1198, 1, { price: 597, commission: 2 }, { price: 575, commission: 1 }), 1175);
  assert.equal(previewSale(null, 2, { price: 1, commission: 0 }, { price: 2, commission: 0 }), null);
  assert.ok(sameTerms({ price: 599, commission: 2 }, { price: 599.001, commission: 2 }));
});

test('the flag is set by a drop under cost, cleared back at cost, else left', () => {
  assert.equal(alertChange({ oldSale: 1198, newSale: 1150, under: 48 }, false), 'set');
  assert.equal(alertChange({ oldSale: 1100, newSale: 1150, under: 48 }, true), 'keep');
  assert.equal(alertChange({ oldSale: 1150, newSale: 1202, under: 0 }, true), 'clear');
  assert.equal(alertChange({ oldSale: 1198, newSale: 1202, under: 0 }, false), 'keep');
  assert.equal(alertChange({ oldSale: 1198, newSale: null, under: 0 }, true), 'keep');
});

const r = (over: Partial<RepriceResult>): RepriceResult => ({ orderId: 7, skip: null, oldSale: 1198, newSale: 1202, under: 0, credits: 0, ...over });

test('message: applied, scheduled, below cost with and without cashback, skipped', () => {
  const from = { price: 597, commission: 2 };
  const to = { price: 599, commission: 2 };
  assert.equal(
    priceChangeText('CM-1', from, to, 'Nov. 23, 2026, 4 a.m.', [r({})], false),
    'BuyingGroup price change on CM-1 (Nov. 23, 2026, 4 a.m.): $597.00 + $2.00 → $599.00 + $2.00 per unit.\n  #7: sale $1,198.00 → $1,202.00',
  );
  const down = priceChangeText('CM-1', to, from, '', [
    r({ newSale: 1150, under: 48 }),
    r({ orderId: 8, newSale: 1150, under: 48, credits: 60 }),
    r({ orderId: 9, newSale: 1150, under: 48, credits: 20 }),
    r({ orderId: 10, skip: 'paid', newSale: null }),
    r({ orderId: 11, skip: 'cancelled', newSale: null }),
  ], true);
  assert.equal(down, [
    'BuyingGroup scheduled a price change on CM-1: $599.00 + $2.00 → $597.00 + $2.00 per unit. When it applies:',
    '  #7: sale $1,198.00 → $1,150.00 ⚠ $48.00 BELOW COST',
    '  #8: sale $1,198.00 → $1,150.00 ⚠ $48.00 BELOW COST, still $12.00 ahead with cashback',
    '  #9: sale $1,198.00 → $1,150.00 ⚠ $48.00 BELOW COST, $28.00 short even with cashback',
    '  #10: already paid, sale stays $1,198.00',
    '  #11: cancelled, left alone',
  ].join('\n'));
  assert.equal(priceChangeText('CM-1', null, to, '', [], false), 'BuyingGroup price change on CM-1: now $599.00 + $2.00 per unit.\n  No orders linked to it.');
  assert.equal(priceChangeText('CM-1', to, to, '', [r({ oldSale: 1202 })], false).split('\n')[1], '  #7: sale $1,202.00 (no change)');
  assert.ok(anyUnderCost([r({ under: 1 })]));
  assert.ok(!anyUnderCost([r({ under: 1, skip: 'paid' })]));
});

test('order note and flag text', () => {
  const res = r({ newSale: 1150, under: 48 });
  assert.equal(priceNoteLine('CM-1', '2026-11-23', { price: 574, commission: 1 }, res), 'BG price 2026-11-23: CM-1 now $574.00 + $1.00/unit, sale $1,198.00 → $1,150.00');
  assert.equal(alertText('CM-1', '2026-11-23', res), 'BuyingGroup price change 2026-11-23 on CM-1: sale $1,198.00 → $1,150.00, $48.00 under cost');
});
