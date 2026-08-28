/**
 * Regression tests for who may claim a pending ExtensionCommand.
 *
 * The bug this guards: app/orders/page.tsx's syncPlatform() and
 * app/settings/page.tsx's queueExtCmd() used to POST a command with no
 * targetBrowser. GET /api/extension/commands (app/api/extension/commands/
 * route.ts) matches a command whose targetBrowser is null against ANY
 * caller's X-Extension-Browser header -- so an untargeted Sync-Amazon
 * command was claimable by a real installed browser extension sending
 * 'chrome'/'firefox', not just the headless sidecar (which sends
 * 'sidecar'). Fixed by targeting those commands at 'sidecar' explicitly,
 * except SYNC_BIGSKY, which the sidecar has no handler for at all (see
 * sidecar/src/poll.js's SITES map) and so is deliberately left untargeted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extensionCommandTargetFilter, callerCanClaim } from './extensionCommandTargeting.ts';

test('an untargeted command is claimable by anyone', () => {
  assert.equal(callerCanClaim(null, 'sidecar'), true);
  assert.equal(callerCanClaim(null, 'chrome'), true);
  assert.equal(callerCanClaim(null, 'firefox'), true);
  assert.equal(callerCanClaim(null, null), true);
});

test('a sidecar-targeted command is claimable only by the sidecar', () => {
  assert.equal(callerCanClaim('sidecar', 'sidecar'), true);
  assert.equal(callerCanClaim('sidecar', 'chrome'), false, 'a real chrome extension must not claim a sidecar-targeted command');
  assert.equal(callerCanClaim('sidecar', 'firefox'), false, 'a real firefox extension must not claim a sidecar-targeted command');
  assert.equal(callerCanClaim('sidecar', null), false, 'a caller with no browser identity must not claim a targeted command');
});

test('the Prisma where-fragment includes null and the caller browser, nothing else', () => {
  assert.deepEqual(extensionCommandTargetFilter('sidecar'), {
    OR: [{ targetBrowser: null }, { targetBrowser: 'sidecar' }],
  });
  assert.deepEqual(extensionCommandTargetFilter('chrome'), {
    OR: [{ targetBrowser: null }, { targetBrowser: 'chrome' }],
  });
});

test('the where-fragment with no caller browser only matches untargeted commands', () => {
  assert.deepEqual(extensionCommandTargetFilter(null), {
    OR: [{ targetBrowser: null }],
  });
});
