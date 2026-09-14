// Adversarial behavioural pin for lib/orderFieldSync.ts.
// Do NOT edit -- the model may only edit the files named in TASK.md's Scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShippingAddress,
  mergeUserEditedFields,
  parseUserEditedFields,
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
