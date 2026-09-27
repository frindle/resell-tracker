/**
 * The allow-list POST /api/extension/commands checks before queueing a
 * command (app/api/extension/commands/route.ts). SYNC_BFMR was added so the
 * app can queue the sidecar's BFMR sync the same way it queues SYNC_COSTCO;
 * anything not on the list must still be rejected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EXTENSION_COMMAND_TYPES, isExtensionCommandType } from './extensionCommandTypes.ts';

test('SYNC_BFMR is accepted, alongside the existing sync commands', () => {
  for (const t of ['SYNC_BFMR', 'SYNC_COSTCO', 'SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_BIGSKY', 'SCRAPE_CBM', 'SYNC_AMAZON_ORDER']) {
    assert.equal(isExtensionCommandType(t), true, t);
  }
});

test('unknown command types are still rejected', () => {
  for (const t of ['SYNC_TARGET', 'sync_bfmr', 'SYNC_BFMR ', '', 'DROP_TABLE']) {
    assert.equal(isExtensionCommandType(t), false, JSON.stringify(t));
  }
});

test('the allow-list has no duplicates', () => {
  assert.equal(new Set(EXTENSION_COMMAND_TYPES).size, EXTENSION_COMMAND_TYPES.length);
});
