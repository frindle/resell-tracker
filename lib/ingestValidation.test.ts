import test from 'node:test';
import assert from 'node:assert/strict';

import { validateIngestFile } from './ingestValidation.ts';

const MB = 1024 * 1024;

test('rejects empty and oversized files (15MB limit)', () => {
  const empty = validateIngestFile({ size: 0, type: 'image/jpeg', name: 'a.jpg' });
  assert.equal(empty.ok, false);
  const big = validateIngestFile({ size: 20 * MB, type: 'image/jpeg', name: 'a.jpg' });
  assert.equal(big.ok, false);
  if (!big.ok) assert.ok(big.status >= 400 && big.error.length > 0);
});

test('rejects non-image types', () => {
  const r = validateIngestFile({ size: 1000, type: 'application/pdf', name: 'a.pdf' });
  assert.equal(r.ok, false);
});

test('accepts heic, jpeg, png', () => {
  assert.deepEqual(validateIngestFile({ size: 2 * MB, type: 'image/heic', name: 'a.heic' }), { ok: true });
  assert.deepEqual(validateIngestFile({ size: 1000, type: 'image/jpeg', name: 'a.jpg' }), { ok: true });
  assert.deepEqual(validateIngestFile({ size: 1000, type: 'image/png', name: 'a.png' }), { ok: true });
});

test('missing type but .heic extension is accepted', () => {
  assert.deepEqual(validateIngestFile({ size: 1000, type: '', name: 'IMG_0001.HEIC' }), { ok: true });
});
