import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvePairing, claimPairing, MAX_PENDING, PAIR_TTL_MS, pairBrowser, pairStore, pendingPairing, sameOriginRequest, startPairing, type PairStore } from './extensionPairing.ts';

const fresh = (): PairStore => new Map();
const USER = { id: 3, name: 'Sam' };

test('start, approve, claim once', () => {
  const s = fresh();
  const p = startPairing(s, 'chrome', 1000)!;
  assert.ok(p.code.length >= 10 && p.claim.length >= 40 && p.code !== p.claim);
  assert.deepEqual(claimPairing(s, p.code, p.claim, 1001), { status: 'pending' });
  assert.deepEqual(pendingPairing(s, p.code, 1002), { browser: 'chrome', createdAt: 1000, approved: false });
  assert.equal(approvePairing(s, p.code, USER, 1003), true);
  assert.equal(approvePairing(s, p.code, { id: 9, name: 'Other' }, 1004), false, 'a second approval cannot rebind it');
  assert.deepEqual(claimPairing(s, p.code, p.claim, 1005), { status: 'approved', userId: 3, userName: 'Sam' });
  assert.deepEqual(claimPairing(s, p.code, p.claim, 1006), { status: 'unknown' }, 'handed out once');
});

test('the code alone never claims', () => {
  const s = fresh();
  const p = startPairing(s, 'chrome', 0)!;
  approvePairing(s, p.code, USER, 1);
  assert.deepEqual(claimPairing(s, p.code, '', 2), { status: 'unknown' });
  assert.deepEqual(claimPairing(s, p.code, p.code, 2), { status: 'unknown' });
  assert.deepEqual(claimPairing(s, p.code, undefined as unknown as string, 2), { status: 'unknown' });
  assert.equal(claimPairing(s, p.code, p.claim, 3).status, 'approved', 'a wrong claim does not burn the pairing');
});

test('expiry and the pending cap', () => {
  const s = fresh();
  const p = startPairing(s, 'firefox', 0)!;
  assert.equal(pendingPairing(s, p.code, PAIR_TTL_MS - 1)?.browser, 'firefox');
  assert.equal(approvePairing(s, p.code, USER, PAIR_TTL_MS), false);
  assert.equal(pendingPairing(s, p.code, PAIR_TTL_MS), null);
  for (let i = 0; i < MAX_PENDING; i++) assert.ok(startPairing(s, 'chrome', PAIR_TTL_MS + i));
  assert.equal(startPairing(s, 'chrome', PAIR_TTL_MS + 100), null);
  assert.ok(startPairing(s, 'chrome', PAIR_TTL_MS * 3), 'expired ones free their slots');
});

test('browser label and the shared store', () => {
  assert.equal(pairBrowser('firefox'), 'firefox');
  assert.equal(pairBrowser('<script>'), 'chrome');
  assert.equal(pairStore(), pairStore());
});

test('sameOriginRequest', () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.equal(sameOriginRequest(h({ 'sec-fetch-site': 'same-origin', origin: 'https://public.example', host: '10.0.0.1:3000' })), true);
  assert.equal(sameOriginRequest(h({ 'sec-fetch-site': 'cross-site', origin: 'http://10.0.0.1:3000', host: '10.0.0.1:3000' })), false);
  assert.equal(sameOriginRequest(h({ 'sec-fetch-site': 'same-site' })), false);
  assert.equal(sameOriginRequest(h({ origin: 'http://10.0.0.1:3000', host: '10.0.0.1:3000' })), true);
  assert.equal(sameOriginRequest(h({ origin: 'https://evil.example', host: '10.0.0.1:3000' })), false);
  assert.equal(sameOriginRequest(h({ origin: 'null', host: '10.0.0.1:3000' })), false);
  assert.equal(sameOriginRequest(h({})), true);
});
