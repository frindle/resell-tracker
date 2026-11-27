import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resyncBeforeMatch, shouldResync, type ResyncDeps, type ResyncSource } from './importResync.ts';
import { matchOrdersWith, type MatchStore } from './commitmentMatchCore.ts';

const T0 = Date.parse('2026-11-27T20:38:00Z');

function deps(over: Partial<ResyncDeps> & { stored?: Partial<Record<ResyncSource, number | null>> } = {}) {
  const ran: ResyncSource[] = [];
  const logs: string[] = [];
  const { stored, ...rest } = over;
  const d: ResyncDeps = {
    lastSyncedMs: async s => stored?.[s] ?? null,
    run: async s => { ran.push(s); return Response.json({ ok: true }); },
    now: () => T0,
    attempts: new Map(),
    log: l => logs.push(l),
    ...rest,
  };
  return { d, ran, logs };
}

test('shouldResync: never synced, old, and fresh', () => {
  assert.equal(shouldResync(null, T0), true);
  assert.equal(shouldResync(T0 - 3 * 60_000, T0), true);
  assert.equal(shouldResync(T0 - 60_000, T0), false);
});

test('a source synced under 2 minutes ago is skipped; the others run', async () => {
  const { d, ran } = deps({ stored: { bg: T0 - 30_000, bigsky: T0 - 10 * 60_000 } });
  const r = await resyncBeforeMatch(1, d);
  assert.deepEqual(r, { bg: 'skipped', bigsky: 'synced', bfmr: 'synced' });
  assert.deepEqual(ran.sort(), ['bfmr', 'bigsky']);
});

test('a burst: the second call inside 2 minutes runs nothing, even after a failure', async () => {
  const attempts = new Map<string, number>();
  const first = deps({ attempts, run: async () => { throw new Error('upstream down'); } });
  await resyncBeforeMatch(1, first.d);
  let t = T0 + 60_000;
  const second = deps({ attempts, now: () => t });
  assert.deepEqual(await resyncBeforeMatch(1, second.d), { bg: 'skipped', bigsky: 'skipped', bfmr: 'skipped' });
  assert.equal(second.ran.length, 0);
  t = T0 + 121_000;
  await resyncBeforeMatch(1, second.d);
  assert.equal(second.ran.length, 3);
});

test('the throttle is per user', async () => {
  const attempts = new Map<string, number>();
  await resyncBeforeMatch(1, deps({ attempts }).d);
  const other = deps({ attempts });
  await resyncBeforeMatch(2, other.d);
  assert.equal(other.ran.length, 3);
});

test('a source that is not connected (400) is off and logs nothing', async () => {
  const { d, logs } = deps({ run: async () => Response.json({ error: 'not connected' }, { status: 400 }) });
  assert.deepEqual(await resyncBeforeMatch(1, d), { bg: 'off', bigsky: 'off', bfmr: 'off' });
  assert.equal(logs.length, 0);
});

test('resync fails, throws or hangs: one log line each, no throw, and the match still links', async () => {
  const { d, logs } = deps({
    timeoutMs: 20,
    run: async s => {
      if (s === 'bg') throw new Error('boom');
      if (s === 'bigsky') return Response.json({ error: 'x' }, { status: 502 });
      return new Promise<Response>(() => {}); // never answers
    },
  });
  const r = await resyncBeforeMatch(1, d);
  assert.deepEqual(r, { bg: 'failed', bigsky: 'failed', bfmr: 'failed' });
  assert.equal(logs.length, 3);
  assert.ok(logs.every(l => l.includes('matching anyway')));
  assert.ok(logs.some(l => l.includes('timed out')));

  // The import's next step (the matcher) still runs and links.
  const links: number[] = [];
  const store: MatchStore = {
    loadOrders: async () => [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: new Date('2026-11-27T00:00:00Z') }],
    loadCandidateRows: async () => ({ bfmr: [], bigsky: [], bg: [{ id: 7, dealTitle: 'Acme Kettle Steel', count: 1, assignedQty: 0, status: 'ACTIVE', expiryDay: null, createdDt: new Date('2026-11-26T00:00:00Z') }] }),
    link: async (_c, orderId) => { links.push(orderId); },
  };
  const m = await matchOrdersWith(store, [1], new Map(), T0);
  assert.equal(m.linked, 1);
  assert.deepEqual(links, [1]);
});

test('a lastSyncedMs error also fails soft', async () => {
  const { d, logs } = deps({ lastSyncedMs: async () => { throw new Error('db'); } });
  const r = await resyncBeforeMatch(1, d);
  assert.deepEqual(r, { bg: 'failed', bigsky: 'failed', bfmr: 'failed' });
  assert.equal(logs.length, 3);
});
