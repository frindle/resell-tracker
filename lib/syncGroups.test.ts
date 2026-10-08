/**
 * Resync Groups must queue the sidecar's BFMR sync, targeted at the sidecar.
 *
 *   node --experimental-strip-types --test lib/syncGroups.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RESYNC_GROUPS_SIDECAR_COMMANDS, resyncGroupsSidecarRequests } from './syncGroups.ts';
import { isExtensionCommandType } from './extensionCommandTypes.ts';

test('Resync Groups queues SYNC_BFMR', () => {
  assert.ok((RESYNC_GROUPS_SIDECAR_COMMANDS as readonly string[]).includes('SYNC_BFMR'));
});

test('retailer syncs are not part of the group resync', () => {
  for (const t of ['SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_COSTCO', 'SYNC_AMAZON_ORDER']) {
    assert.ok(!(RESYNC_GROUPS_SIDECAR_COMMANDS as readonly string[]).includes(t), t);
  }
});

test('every Resync Groups command is sidecar-targeted and queueable', () => {
  const reqs = resyncGroupsSidecarRequests();
  assert.equal(reqs.length, RESYNC_GROUPS_SIDECAR_COMMANDS.length);
  for (const r of reqs) {
    assert.equal(r.targetBrowser, 'sidecar');
    assert.ok(isExtensionCommandType(r.type), r.type);
  }
});

import { sidecarOutcome } from './syncGroups.ts';

test('sidecarOutcome: session-expired failure asks to log in again', () => {
  const o = sidecarOutcome({ status: 'failed', result: JSON.stringify({ error: 'bfmr session expired or not logged in' }) });
  assert.equal(o.needsLogin, true);
  assert.equal(o.active, false);
  assert.match(o.text, /log in again/);
  const noSession = sidecarOutcome({ status: 'failed', result: JSON.stringify({ error: 'no saved bfmr session — run the one-time interactive login' }) });
  assert.equal(noSession.needsLogin, true);
});

test('sidecarOutcome: other failure shows the error, no login link', () => {
  const o = sidecarOutcome({ status: 'failed', result: JSON.stringify({ error: 'boom' }) });
  assert.equal(o.needsLogin, false);
  assert.match(o.text, /failed — boom/);
});

test('sidecarOutcome: done shows rows accepted', () => {
  const o = sidecarOutcome({ status: 'done', result: JSON.stringify({ platform: 'BFMR', scraped: 5, accepted: 4 }) });
  assert.equal(o.needsLogin, false);
  assert.equal(o.active, false);
  assert.match(o.text, /done — 4 of 5 rows accepted/);
});

test('sidecarOutcome: still running after the poll budget defers to the corner indicator', () => {
  const o = sidecarOutcome({ status: 'running', result: null }, true);
  assert.equal(o.active, true);
  assert.match(o.text, /corner indicator/);
  assert.equal(sidecarOutcome({ status: 'pending', result: null }).active, true);
});

test('sidecarOutcome: unreadable command falls back to the corner indicator', () => {
  const o = sidecarOutcome(null);
  assert.equal(o.active, false);
  assert.match(o.text, /corner indicator/);
});

test('Resync Groups uses the BFMR API for tracker rows; sidecar only as fallback', async () => {
  const { bfmrTrackerOutcome } = await import('./syncGroups.ts');
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: { webBackfilled: 3 } }), { note: '3 tracker IDs linked', needsSidecar: false });
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: {} }), { note: '', needsSidecar: false });
  // expired / reCAPTCHA-gated session, or the call itself failing -> sidecar
  assert.equal(bfmrTrackerOutcome({ ok: true, body: { webError: 'login 403' } }).needsSidecar, true);
  assert.equal(bfmrTrackerOutcome({ ok: false, body: null }).needsSidecar, true);
  assert.equal(bfmrTrackerOutcome({ ok: true, body: null }).needsSidecar, true);
});

test('BFMR appears once in the Resync Groups status line', async () => {
  const { bfmrStatusPart } = await import('./syncGroups.ts');
  assert.equal(bfmrStatusPart({ ok: true, created: 0, updated: 2 }, ''), 'BFMR: +0 new, 2 updated');
  assert.equal(bfmrStatusPart({ ok: true }, '1 tracker ID linked'), 'BFMR: no changes, 1 tracker ID linked');
  assert.equal(bfmrStatusPart({ ok: false }, ''), 'BFMR: failed');
});
