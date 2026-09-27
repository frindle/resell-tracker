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
