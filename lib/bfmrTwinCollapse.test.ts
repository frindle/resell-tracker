// npm run test:bfmr-twin-collapse -- step 3 of selectCanonicalBfmrLinks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCanonicalBfmrLinks } from './bfmrLinkReconcile.ts';

const mk = (id: number, reserveId: string, tracking: string, at: string) => ({
  id,
  reservationId: id,
  trackingNumber: tracking,
  reservationTracking: tracking,
  reserveId,
  quantity: 2,
  lastSyncedAt: at,
});

test('reserveIds differing only in case do not collapse', () => {
  const out = selectCanonicalBfmrLinks([
    mk(1, 'AbCd==', 'T1', '2026-01-01T00:00:00Z'),
    mk(2, 'abcd==', 'T1', '2026-02-01T00:00:00Z'),
  ]);
  assert.deepEqual(out.map((l) => l.id), [1, 2]);
});

test('same reserveId, tracking differing only in case, same qty -> newest lastSyncedAt', () => {
  const out = selectCanonicalBfmrLinks([
    mk(1, 'AbCd==', 'tr1', '2026-01-01T00:00:00Z'),
    mk(2, 'AbCd==', 'TR1', '2026-02-01T00:00:00Z'),
  ]);
  assert.deepEqual(out.map((l) => l.id), [2]);
});
