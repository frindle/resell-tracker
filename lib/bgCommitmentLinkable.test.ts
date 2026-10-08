import test from 'node:test';
import assert from 'node:assert/strict';
import { linkableCommitments } from './bgCommitmentLinkable.ts';

const NOW = Date.parse('2026-10-05T19:00:00.000Z'); // 2026-10-05 noon PDT
const mk = (id: number, o: Partial<{ status: string; remaining: number; expiryDay: string | null }> = {}) =>
  ({ id, status: 'ACTIVE', remaining: 2, expiryDay: '2026-10-06T00:00:00.000Z', ...o });

test('expired commitment is hidden, future is returned, null expiry is returned', () => {
  const list = [mk(1, { expiryDay: '2026-10-04T00:00:00.000Z' }), mk(2), mk(3, { expiryDay: null })];
  assert.deepEqual(linkableCommitments(list, [], NOW).map(c => c.id), [2, 3]);
});

test('expiry day is inclusive in Pacific time', () => {
  // expires 2026-10-08 (stored midnight UTC). 2026-10-07 17:30 PDT is past that
  // instant but still the day before: must stay linkable (the reported bug).
  const c = mk(1, { expiryDay: '2026-10-08T00:00:00.000Z' });
  assert.deepEqual(linkableCommitments([c], [], Date.parse('2026-10-08T00:30:00.000Z')), [c]);
  // late on 2026-10-08 Pacific: still linkable
  assert.deepEqual(linkableCommitments([c], [], Date.parse('2026-10-09T06:59:00.000Z')), [c]);
  // 2026-10-09 00:01 PDT: expired
  assert.deepEqual(linkableCommitments([c], [], Date.parse('2026-10-09T07:01:00.000Z')), []);
});

test('linked-here expired commitment is excluded without mutating the input', () => {
  const expired = mk(1, { expiryDay: '2026-10-04T00:00:00.000Z' });
  const list = [expired, mk(2)];
  assert.deepEqual(linkableCommitments(list, [1], NOW).map(c => c.id), [2]);
  assert.equal(list.length, 2);
  assert.equal(list[0], expired);
});

test('status and remaining gate', () => {
  const list = [mk(1, { status: 'FULFILLED' }), mk(2, { status: 'VOIDED' }), mk(3, { remaining: 0 }), mk(4, { status: 'PARTIALLY FULFILLED', remaining: 1 })];
  assert.deepEqual(linkableCommitments(list, [], NOW).map(c => c.id), [4]);
});

test('non-expired linked-here id is hidden; order preserved; unparseable expiry counts as none', () => {
  const list = [mk(5), mk(3, { expiryDay: 'not-a-date' }), mk(4), mk(1)];
  assert.deepEqual(linkableCommitments(list, [4], NOW).map(c => c.id), [5, 3, 1]);
});
