import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEgiftEmail, maskEgiftEmail, pickEgiftEmail } from './egiftEmail.ts';

test('normalizeEgiftEmail trims and lower-cases only the domain', () => {
  assert.equal(normalizeEgiftEmail('  Buyer@Example.TEST '), 'Buyer@example.test');
});

test('normalizeEgiftEmail rejects things that are not addresses', () => {
  for (const v of ['', 'nope', 'a@b', 'a b@c.test', '@x.test', 42, null, undefined]) {
    assert.equal(normalizeEgiftEmail(v), null);
  }
  assert.equal(normalizeEgiftEmail(`${'a'.repeat(250)}@x.test`), null);
});

test('maskEgiftEmail hides the local part', () => {
  assert.equal(maskEgiftEmail('buyer@example.test'), 'b•••@example.test');
  assert.equal(maskEgiftEmail('garbage'), '•••');
});

test('pickEgiftEmail prefers the order address, falls back to the default', () => {
  assert.deepEqual(pickEgiftEmail('a@one.test', 'b@two.test'), { email: 'a@one.test', source: 'order' });
  assert.deepEqual(pickEgiftEmail(null, 'B@Two.test'), { email: 'B@two.test', source: 'default' });
  assert.deepEqual(pickEgiftEmail('bad', 'also bad'), { email: null, source: null });
});
