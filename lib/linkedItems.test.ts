import test from 'node:test';
import assert from 'node:assert/strict';

import { combineLinkedTitles, planLinkedSync, type LinkGroup } from './linkedItems.ts';

const ORDER = { itemDescription: 'Wearable Technology (3 items)', buyerId: null, userEditedFields: [], locked: false, cancelled: false };
const BUYERS: Record<LinkGroup, number> = { BFMR: 1, BuyingGroup: 2, BigSkyBuyers: 3 };
const buyerIdFor = (g: LinkGroup) => BUYERS[g];

test('linking replaces the email category with the reservation title and sets the group (order 1049)', () => {
  const plan = planLinkedSync(ORDER, [{ group: 'BFMR', title: 'Apple Watch Series 12 - Cellular - 46mm', quantity: 3 }], buyerIdFor);
  assert.deepEqual(plan, { itemDescription: 'Apple Watch Series 12 - Cellular - 46mm ×3', buyerId: 1 });
});

test('a description the person typed is kept; the buyer is still filled', () => {
  const plan = planLinkedSync({ ...ORDER, userEditedFields: ['itemDescription'] }, [{ group: 'BuyingGroup', title: 'Switch 2', quantity: 1 }], buyerIdFor);
  assert.deepEqual(plan, { buyerId: 2 });
});

test('an order that already has a buyer keeps it', () => {
  const plan = planLinkedSync({ ...ORDER, buyerId: 4 }, [{ group: 'BFMR', title: 'Yoga 7', quantity: 1 }], buyerIdFor);
  assert.deepEqual(plan, { itemDescription: 'Yoga 7' });
});

test('links with two groups set the titles but not a buyer', () => {
  const plan = planLinkedSync(ORDER, [
    { group: 'BFMR', title: 'Laptop A', quantity: 1 },
    { group: 'BuyingGroup', title: 'Laptop B', quantity: 2 },
  ], buyerIdFor);
  assert.deepEqual(plan, { itemDescription: 'Laptop A + Laptop B ×2' });
});

test('locked, cancelled, unlinked or unchanged orders are left alone', () => {
  const links = [{ group: 'BFMR' as const, title: 'Yoga 7', quantity: 1 }];
  assert.deepEqual(planLinkedSync({ ...ORDER, locked: true }, links, buyerIdFor), {});
  assert.deepEqual(planLinkedSync({ ...ORDER, cancelled: true }, links, buyerIdFor), {});
  assert.deepEqual(planLinkedSync(ORDER, [], buyerIdFor), {});
  assert.deepEqual(planLinkedSync({ ...ORDER, itemDescription: 'Yoga 7', buyerId: 1 }, links, buyerIdFor), {});
});

test('a group with no buyer row sets no buyer', () => {
  assert.deepEqual(planLinkedSync(ORDER, [{ group: 'BigSkyBuyers', title: 'TV', quantity: 1 }], () => null), { itemDescription: 'TV' });
});

test('titles: duplicates merge their quantities, blanks are skipped, spacing is tidied', () => {
  assert.equal(combineLinkedTitles([
    { group: 'BFMR', title: '  Yoga  7 ', quantity: 1 },
    { group: 'BFMR', title: 'yoga 7', quantity: 1 },
    { group: 'BFMR', title: null, quantity: 1 },
    { group: 'BFMR', title: '', quantity: 1 },
  ]), 'Yoga 7 ×2');
  assert.equal(combineLinkedTitles([{ group: 'BFMR', title: null, quantity: 1 }]), null);
});

test('keepItem: the order item name stays, a blank buyer is still filled', () => {
  const plan = planLinkedSync(ORDER, [{ group: 'BFMR', title: 'Yoga 7', quantity: 1 }], buyerIdFor, { keepItem: true });
  assert.equal('itemDescription' in plan, false);
});
