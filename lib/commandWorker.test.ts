import test from 'node:test';
import assert from 'node:assert/strict';
import { commandWorker, commandTarget, isCostcoCommand } from './commandWorker.ts';

test('Costco and Amazon commands go to the extension', () => {
  for (const t of ['SYNC_COSTCO', 'SYNC_COSTCO_ORDER', 'SYNC_AMAZON_PAGES', 'TRACK_AMAZON', 'VISIT_AMAZON']) {
    assert.equal(commandWorker(t), 'extension');
    assert.equal(commandTarget(t), 'chrome');
  }
});

test('Walmart, BFMR and the scrapes stay on the sidecar', () => {
  for (const t of ['SYNC_WALMART', 'SYNC_WALMART_ORDER', 'SYNC_BFMR', 'SCRAPE_CBM', 'SCRAPE_MGCP']) {
    assert.equal(commandWorker(t), 'sidecar');
    assert.equal(commandTarget(t), 'sidecar');
  }
});

test('types with no fixed worker stay untargeted', () => {
  assert.equal(commandWorker('SYNC_BIGSKY'), null);
  assert.equal(commandTarget('SYNC_BIGSKY'), null);
  assert.equal(commandTarget('NOPE'), null);
});

test('isCostcoCommand covers both Costco types only', () => {
  assert.equal(isCostcoCommand('SYNC_COSTCO'), true);
  assert.equal(isCostcoCommand('SYNC_COSTCO_ORDER'), true);
  assert.equal(isCostcoCommand('SYNC_WALMART'), false);
});
