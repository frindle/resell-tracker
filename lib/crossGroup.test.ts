import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUpc, normalizeModel, computeFlags, badgeText, parseThreshold, collectGroups, TtlCache,
  type GroupEntry,
} from './crossGroup.ts';

const e = (o: Partial<GroupEntry> & Pick<GroupEntry, 'group' | 'id' | 'payout'>): GroupEntry =>
  ({ title: o.id, upcs: [], models: [], href: `/x/${o.id}`, ...o });

test('UPC-A, EAN-13 and GTIN-14 normalize alike', () => {
  const a = normalizeUpc('194253397601');
  assert.ok(a);
  assert.equal(a, normalizeUpc('0194253397601'));
  assert.equal(a, normalizeUpc('00194253397601'));
  assert.equal(a, normalizeUpc(' 1942-5339-7601 '));
});

test('junk UPCs are rejected', () => {
  for (const v of ['', '0000000000000', '123', null, undefined, {}, '12345678901234567']) assert.equal(normalizeUpc(v), null);
});

test('models match exactly, case and spaces aside', () => {
  assert.equal(normalizeModel('mjed4ls/a'), 'MJED4LS/A');
  assert.equal(normalizeModel(' MJED 4LS/A '), 'MJED4LS/A');
  assert.notEqual(normalizeModel('MJED4LS'), normalizeModel('MJED4LS/A'));
  for (const v of ['Black', '2024', 'N/A', 'ABC1', null, 5]) assert.equal(normalizeModel(v), null);
});

test('flags a UPC match across groups when it pays more than the threshold', () => {
  const f = computeFlags([
    e({ group: 'bfmr', id: 's1', payout: 100, upcs: ['194253397601'] }),
    e({ group: 'bg', id: 'k1', payout: 112, upcs: ['0194253397601'] }),
  ]);
  assert.equal(f['bfmr:s1'].group, 'bg');
  assert.equal(f['bfmr:s1'].diff, 12);
  assert.equal(f['bfmr:s1'].href, '/x/k1');
  assert.equal(f['bfmr:s1'].matchedBy, 'upc');
  assert.equal(badgeText(f['bfmr:s1']), 'BG pays $12.00 more');
  assert.equal(f['bg:k1'], undefined);
});

test('threshold: equal, tiny and exactly-threshold differences do not flag', () => {
  const mk = (bg: number, t?: number) => computeFlags([
    e({ group: 'bfmr', id: 's', payout: 100, upcs: ['194253397601'] }),
    e({ group: 'bg', id: 'k', payout: bg, upcs: ['194253397601'] }),
  ], t);
  assert.deepEqual(Object.keys(mk(100)), []);
  assert.deepEqual(Object.keys(mk(100.5)), []);
  assert.deepEqual(Object.keys(mk(101)), []);
  assert.deepEqual(Object.keys(mk(101.01)), ['bfmr:s']);
  assert.deepEqual(Object.keys(mk(100.5, 0.25)), ['bfmr:s']);
});

test('falls back to an exact model when no UPC matches', () => {
  const f = computeFlags([
    e({ group: 'bg', id: 'k', payout: 50, models: ['MJED4LS/A'] }),
    e({ group: 'bfmr', id: 's', payout: 70, upcs: ['111111111111'], models: ['mjed4ls/a'] }),
  ]);
  assert.equal(f['bg:k'].matchedBy, 'model');
  assert.equal(f['bg:k'].diff, 20);
});

test('title-only similarity never flags', () => {
  const f = computeFlags([
    e({ group: 'bg', id: 'k', title: 'Apple AirPods Pro 2 USB-C', payout: 50 }),
    e({ group: 'bfmr', id: 's', title: 'Apple AirPods Pro 2 USB-C', payout: 90 }),
  ]);
  assert.deepEqual(f, {});
});

test('same-group rows never flag each other, and the best other group wins', () => {
  const f = computeFlags([
    e({ group: 'bfmr', id: 'a', payout: 10, upcs: ['194253397601'] }),
    e({ group: 'bfmr', id: 'b', payout: 99, upcs: ['194253397601'] }),
    e({ group: 'bg', id: 'x', payout: 30, upcs: ['194253397601'] }),
    e({ group: 'bigsky', id: 'y', payout: 40, upcs: ['194253397601'] }),
  ]);
  assert.equal(f['bfmr:a'].group, 'bigsky');
  assert.equal(f['bg:x'].id, 'b');
});

test('a UPC match is not overridden by a model match', () => {
  const f = computeFlags([
    e({ group: 'bg', id: 'k', payout: 10, upcs: ['194253397601'], models: ['AB1234'] }),
    e({ group: 'bfmr', id: 'u', payout: 12, upcs: ['194253397601'] }),
    e({ group: 'bigsky', id: 'm', payout: 99, models: ['AB1234'] }),
  ]);
  assert.equal(f['bg:k'].id, 'u');
});

test('threshold parsing', () => {
  assert.equal(parseThreshold(undefined), 1);
  assert.equal(parseThreshold(''), 1);
  assert.equal(parseThreshold('abc'), 1);
  assert.equal(parseThreshold('-2'), 1);
  assert.equal(parseThreshold('2.5'), 2.5);
  assert.equal(parseThreshold('0'), 0);
});

test('collectGroups loads each group once and skips a failing one', async () => {
  let calls = 0;
  const r = await collectGroups([
    { group: 'bfmr', load: async () => { calls++; return [e({ group: 'bfmr', id: 's', payout: 1 })]; } },
    { group: 'bg', load: async () => { calls++; throw new Error('logged out'); } },
  ]);
  assert.equal(calls, 2);
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.skipped, [{ group: 'bg', reason: 'logged out' }]);
});

test('TtlCache serves within the ttl, reloads after, and shares an in-flight load', async () => {
  let t = 0, loads = 0;
  const c = new TtlCache<number>(1000, () => t);
  const load = async () => ++loads;
  const [a, b] = await Promise.all([c.get(load), c.get(load)]);
  assert.deepEqual([a, b, loads], [1, 1, 1]);
  t = 999; assert.equal(await c.get(load), 1);
  t = 1000; assert.equal(await c.get(load), 2);
});
