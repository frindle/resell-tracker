import test from 'node:test';
import assert from 'node:assert/strict';
import { decideGroup, countDecisions, type Deal, type DealGroup, type GroupFillOrder } from './groupFill.ts';

const BUYERS: Record<DealGroup, number> = { BFMR: 1, BuyingGroup: 2, BigSkyBuyers: 3 };
const buyerIdFor = (g: DealGroup) => BUYERS[g];
const RULES = [
  { pattern: '10 Alpha Road, Springfield, ZZ', buyerId: 1 },
  { pattern: '20 Beta Lane, Shelbyville, ZZ', buyerId: 2 },
];
const ORDER_DAY = Date.UTC(2026, 10, 19);
const order = (x: Partial<GroupFillOrder> = {}): GroupFillOrder => ({
  buyerId: null, userEditedFields: [], shippingAddress: '999 Other St, Capital City, ZZ 00001', itemDescription: 'Acme Laptop 14 inch 16GB 512GB', orderDateMs: ORDER_DAY, ...x,
});
const deal = (x: Partial<Deal> = {}): Deal => ({ group: 'BuyingGroup', name: 'Acme Laptop 14 inch 16GB 512GB', createdAt: ORDER_DAY - 86_400_000, ...x });

test('a shipping rule hit sets the group from the address', () => {
  const d = decideGroup(order({ shippingAddress: '10 Alpha Road, Springfield, ZZ 00001' }), RULES, [], buyerIdFor);
  assert.deepEqual(d, { kind: 'set', buyerId: 1, via: 'rule' });
});

test('the rule wins over a deal that points elsewhere', () => {
  const d = decideGroup(order({ shippingAddress: '20 Beta Lane, Shelbyville, ZZ 00002' }), RULES, [deal({ group: 'BFMR', createdAt: undefined })], buyerIdFor);
  assert.deepEqual(d, { kind: 'set', buyerId: 2, via: 'rule' });
});

test('no rule: the item falls back to the one group with a matching deal', () => {
  const d = decideGroup(order(), RULES, [deal(), deal({ name: 'Other Phone 128GB' })], buyerIdFor);
  assert.deepEqual(d, { kind: 'set', buyerId: 2, via: 'item' });
  // Several deals of the same group are still one group.
  assert.deepEqual(decideGroup(order(), RULES, [deal(), deal()], buyerIdFor), { kind: 'set', buyerId: 2, via: 'item' });
});

test('ambiguous: deals in two groups set nothing', () => {
  const d = decideGroup(order(), RULES, [deal(), deal({ group: 'BFMR', createdAt: undefined })], buyerIdFor);
  assert.deepEqual(d, { kind: 'ambiguous' });
});

test('no rule and no matching deal sets nothing', () => {
  assert.deepEqual(decideGroup(order(), RULES, [deal({ name: 'Other Phone 128GB' })], buyerIdFor), { kind: 'none' });
  assert.deepEqual(decideGroup(order({ itemDescription: null }), RULES, [deal()], buyerIdFor), { kind: 'none' });
  // A different size is a different product.
  assert.deepEqual(decideGroup(order({ itemDescription: 'Acme Laptop 16 inch 16GB 512GB' }), RULES, [deal()], buyerIdFor), { kind: 'none' });
});

test('a deal made after the order day is not what it was bought for', () => {
  assert.deepEqual(decideGroup(order(), RULES, [deal({ createdAt: ORDER_DAY + 3 * 86_400_000 })], buyerIdFor), { kind: 'none' });
  assert.deepEqual(decideGroup(order(), RULES, [deal({ createdAt: null })], buyerIdFor), { kind: 'none' });
});

test('a cancelled and locked order with no group is filled the same way (only the group is decided)', () => {
  // The decision carries nothing but a group: cost, status, links and payout are not in its answer.
  const d = decideGroup(order({ shippingAddress: '10 Alpha Road, Springfield, ZZ 00001' }), RULES, [], buyerIdFor);
  assert.deepEqual(Object.keys(d).sort(), ['buyerId', 'kind', 'via']);
  // A voided deal (the caller passes it for a cancelled order) still places the item.
  assert.deepEqual(decideGroup(order(), RULES, [deal({ group: 'BuyingGroup' })], buyerIdFor), { kind: 'set', buyerId: 2, via: 'item' });
});

test('a group the user set is never overwritten', () => {
  const rule = order({ buyerId: 3, shippingAddress: '10 Alpha Road, Springfield, ZZ 00001' });
  assert.deepEqual(decideGroup(rule, RULES, [deal()], buyerIdFor), { kind: 'keep' });
  // A group the user cleared on purpose is kept empty.
  const cleared = order({ userEditedFields: ['buyerId'], shippingAddress: '10 Alpha Road, Springfield, ZZ 00001' });
  assert.deepEqual(decideGroup(cleared, RULES, [deal()], buyerIdFor), { kind: 'keep' });
});

test('a group with no buyer row sets nothing', () => {
  assert.deepEqual(decideGroup(order(), RULES, [deal()], () => null), { kind: 'none' });
});

test('countDecisions', () => {
  const c = countDecisions([
    { kind: 'set', buyerId: 1, via: 'rule' }, { kind: 'set', buyerId: 2, via: 'item' },
    { kind: 'ambiguous' }, { kind: 'none' }, { kind: 'keep' },
  ]);
  assert.deepEqual(c, { scanned: 5, byRule: 1, byItem: 1, ambiguous: 1, none: 1, kept: 1 });
});
