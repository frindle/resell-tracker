// Adversarial behavioural pin for lib/orderFieldSync.ts.
// Do NOT edit -- the model may only edit the files named in TASK.md's Scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShippingAddress,
  mergeUserEditedFields,
  parseUserEditedFields,
  resolveOrderSyncFields,
  loadAndMergeUserEditedFields,
} from './orderFieldSync.ts';

const OLD_ADDR = '13 Fl4gst0ne Dr, Hudson, NH 03051';
const NEW_ADDR = '146 R1ver Rhode, new castle, DE 19720';

// (a) address changed on Amazon + a DIFFERENT field (card) was user-edited:
// the scrape must be free to update shippingAddress, and the resolver must
// signal downstream buyer re-match + recalc should re-fire.
test('address updates from scrape when only cardId was user-edited (order 919 case)', () => {
  const editedFields = JSON.stringify(['cardId']);
  const result = resolveShippingAddress(OLD_ADDR, NEW_ADDR, editedFields);
  assert.equal(result.shippingAddress, NEW_ADDR);
  assert.equal(result.addressChanged, true);
});

// (b) the user edited shippingAddress itself: never let a scrape clobber it,
// even though the incoming value differs -- this is the guard's real purpose.
test('address is NOT overwritten when the user edited shippingAddress itself', () => {
  const editedFields = JSON.stringify(['shippingAddress']);
  const result = resolveShippingAddress(OLD_ADDR, NEW_ADDR, editedFields);
  assert.equal(result.shippingAddress, OLD_ADDR);
  assert.equal(result.addressChanged, false);
});

// (c) address unchanged: no needless rewrite / no false re-trigger of
// buyer re-match + recalc, regardless of what else was user-edited.
test('no addressChanged signal when the scraped address matches the stored one', () => {
  const editedFields = JSON.stringify(['cardId']);
  const result = resolveShippingAddress(OLD_ADDR, OLD_ADDR, editedFields);
  assert.equal(result.shippingAddress, OLD_ADDR);
  assert.equal(result.addressChanged, false);
});

// A scrape that brings nothing new must never null out a stored address.
test('a missing/empty scraped address keeps the stored value and does not signal a change', () => {
  const editedFields = JSON.stringify([]);
  const result = resolveShippingAddress(OLD_ADDR, null, editedFields);
  assert.equal(result.shippingAddress, OLD_ADDR);
  assert.equal(result.addressChanged, false);
});

// mergeUserEditedFields must record ONLY the field(s) actually edited in this
// PATCH -- editing cardId must never implicitly protect shippingAddress too
// (that whole-order conflation is exactly the bug).
test('mergeUserEditedFields records only the fields actually patched', () => {
  const merged = mergeUserEditedFields(null, ['cardId']);
  const fields = parseUserEditedFields(merged);
  assert.ok(fields.includes('cardId'));
  assert.ok(!fields.includes('shippingAddress'));
});

// Editing shippingAddress must ADD to (not replace) a prior edited-fields
// set, and must dedupe on repeat edits.
test('mergeUserEditedFields accumulates and dedupes across edits', () => {
  const afterCard = mergeUserEditedFields(null, ['cardId']);
  assert.deepEqual(parseUserEditedFields(afterCard).sort(), ['cardId']);
  const afterAddress = mergeUserEditedFields(afterCard, ['shippingAddress', 'cardId']);
  const fields = parseUserEditedFields(afterAddress);
  // EXACT set (not just .includes) -- catches a mutant that parses the raw
  // JSON *string* itself (e.g. as characters) instead of the field names it
  // decodes to, which would still make .includes('cardId') true by accident.
  assert.deepEqual(fields.sort(), ['cardId', 'shippingAddress']);
});

// Malformed stored JSON must never throw -- it must degrade to "no fields
// protected" rather than crashing the import sync path.
test('parseUserEditedFields tolerates malformed/legacy stored values', () => {
  assert.deepEqual(parseUserEditedFields(null), []);
  assert.deepEqual(parseUserEditedFields('not json'), []);
  assert.deepEqual(parseUserEditedFields('{"not":"an array"}'), []);
});

// The order-919 case end to end: address changed on Amazon, only cardId was
// user-edited -- the buyer re-match MUST re-fire against the NEW address,
// not stay frozen on the buyer matched from the old one.
test('resolveOrderSyncFields re-matches the buyer against the NEW address (order 919)', () => {
  let matchedWith: string | undefined;
  const matchBuyerId = (address: string | undefined) => { matchedWith = address; return 42; };
  const existing = { shippingAddress: OLD_ADDR, buyerId: 7, userEditedFields: JSON.stringify(['cardId']) };
  const result = resolveOrderSyncFields(existing, { shippingAddress: NEW_ADDR }, matchBuyerId);
  assert.equal(result.resolvedShippingAddress, NEW_ADDR);
  assert.equal(result.addressChanged, true);
  assert.equal(result.resolvedBuyerId, 42);
  assert.equal(matchedWith, NEW_ADDR);
});

// If the user hand-assigned buyerId itself, an address change must NOT
// override their choice, even though the address itself is free to update.
test('resolveOrderSyncFields protects a user-assigned buyerId from an address-driven re-match', () => {
  const matchBuyerId = () => 99; // would prove the guard failed if this fires
  const existing = { shippingAddress: OLD_ADDR, buyerId: 7, userEditedFields: JSON.stringify(['buyerId']) };
  const result = resolveOrderSyncFields(existing, { shippingAddress: NEW_ADDR }, matchBuyerId);
  assert.equal(result.resolvedShippingAddress, NEW_ADDR);
  assert.equal(result.resolvedBuyerId, 7);
});

// No address change -> no re-match call at all, and the existing buyerId is
// left untouched (this is the "no needless rewrite" case at the combined-
// field level, not just the address alone).
test('resolveOrderSyncFields leaves buyerId untouched when the address did not change', () => {
  let called = false;
  const matchBuyerId = () => { called = true; return 1; };
  const existing = { shippingAddress: OLD_ADDR, buyerId: 7, userEditedFields: JSON.stringify(['cardId']) };
  const result = resolveOrderSyncFields(existing, { shippingAddress: OLD_ADDR }, matchBuyerId);
  assert.equal(result.addressChanged, false);
  assert.equal(result.resolvedBuyerId, 7);
  assert.equal(called, false);
});

// loadAndMergeUserEditedFields is what the PATCH route calls -- driven here
// with a stub prisma client (no real DB needed) to prove the read+merge
// wiring itself, not just the pure merge function in isolation.
test('loadAndMergeUserEditedFields reads the CURRENT stored value and merges the new edit in', async () => {
  let queried: unknown = null;
  const stubPrisma = {
    order: {
      findUnique: async (args: unknown) => { queried = args; return { userEditedFields: JSON.stringify(['cardId']) }; },
    },
  };
  const merged = await loadAndMergeUserEditedFields(stubPrisma, 919, 3, ['shippingAddress']);
  assert.deepEqual(parseUserEditedFields(merged).sort(), ['cardId', 'shippingAddress']);
  assert.deepEqual(queried, { where: { id: 919, userId: 3 }, select: { userEditedFields: true } });
});

// A brand-new order (no prior userEditedFields row, or the findUnique
// returns null) must not throw -- it merges against an empty set.
test('loadAndMergeUserEditedFields tolerates a null lookup result', async () => {
  const stubPrisma = { order: { findUnique: async () => null } };
  const merged = await loadAndMergeUserEditedFields(stubPrisma, 1, null, ['cardId']);
  assert.deepEqual(parseUserEditedFields(merged), ['cardId']);
});
