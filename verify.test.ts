// Adversarial repo-style test for: rt-address-normalize (tsx --test, tsconfig @/ paths)
// normalizeRetailerAddresses trims/normalizes scraped retailer addresses, drops
// unshippable ones (no line1), defaults country, and dedupes (OR-ing isDefault).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRetailerAddresses } from '@/lib/retailerAddressImport';

const A = { platform: 'amazon', fullName: 'Jane Doe', line1: '123 Main St', city: 'Reno', state: 'NV', postalCode: '89501', country: 'US', isDefault: false, externalId: 'amz-1' };

test('basic: two distinct addresses normalize to two rows, externalId/platform preserved', () => {
  const out = normalizeRetailerAddresses([A, { ...A, line1: '99 Oak Ave', externalId: 'amz-2' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].platform, 'amazon');
  assert.equal(out[0].externalId, 'amz-1');
  assert.ok(typeof out[0].dedupeKey === 'string' && out[0].dedupeKey.length > 0);
});

test('drops unshippable entry with no line1', () => {
  const out = normalizeRetailerAddresses([A, { ...A, line1: '   ', externalId: 'amz-blank' }, { ...A, line1: null as any, externalId: 'amz-null' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].externalId, 'amz-1');
});

test('trims and collapses whitespace in fields', () => {
  const out = normalizeRetailerAddresses([{ ...A, line1: '  123   Main  St  ', city: ' Reno ' }]);
  assert.equal(out[0].line1, '123 Main St');
  assert.equal(out[0].city, 'Reno');
});

test('defaults missing country to US, uppercased', () => {
  const out = normalizeRetailerAddresses([{ ...A, country: undefined as any }, { ...A, line1: '5 B St', country: 'us' }]);
  assert.equal(out[0].country, 'US');
  assert.equal(out[1].country, 'US');
});

test('DEDUPE: same key across two entries collapses to one, isDefault OR-ed true', () => {
  const dup1 = { ...A, isDefault: false, externalId: 'amz-1' };
  const dup2 = { ...A, isDefault: true, externalId: 'amz-1b' }; // same name/line1/zip/platform
  const out = normalizeRetailerAddresses([dup1, dup2]);
  assert.equal(out.length, 1);
  assert.equal(out[0].isDefault, true);
});

test('OVER-TRIGGER GUARD: different postalCode is NOT a duplicate', () => {
  const out = normalizeRetailerAddresses([A, { ...A, postalCode: '89502' }]);
  assert.equal(out.length, 2);
});

test('degenerate: empty array returns empty array, does not throw', () => {
  assert.deepEqual(normalizeRetailerAddresses([]), []);
});

test('isDefault preserved when true on a unique row', () => {
  const out = normalizeRetailerAddresses([{ ...A, isDefault: true }]);
  assert.equal(out[0].isDefault, true);
});
