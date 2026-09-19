// Adversarial cases for the web-backfill resolution pass.
//
// THE CONFIRMED DEFECT: matchSplitGroups() landed in bf4ca57 and resolves
// split commitments correctly, but NOTHING CALLS IT. The sync route still
// runs only the 1:1 bfmrJoinKey pass, so every half of a split commitment
// falls into `unmatched`, keeps myTrackerId null forever, and every tracking
// submit for it 409s. These cases pin the RESOLUTION as a whole -- the 1:1
// pass, the split fallback, and the refusal to guess -- behind one pure
// function, plus a structural pin that the route actually calls it.
//
// Every case below MUST fail at baseline (resolveTrackerBackfill does not
// exist yet) and pass only once both the helper and its wiring land.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTrackerBackfill } from './bfmrJoin';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = join(HERE, '..', 'app', 'api', 'bfmr', 'sync-reservations', 'route.ts');

// A split commitment as it actually appears: ONE web row (qty 2, one
// my_tracker_id) against TWO local rows whose qtys sum to it, each carrying
// its own order_id -- so neither half can ever match on the 1:1 key.
const SPLIT_WEB = {
  reserved_at: '2026-08-25 12:05:05',
  item_model_number: 'MX2D3AM/A',
  qty: '2',
  order_id: null,
  my_tracker_id: 4901929,
};
const SPLIT_LOCAL_A = {
  id: 11,
  reserved_at: '08/25/2026 12:05:05',
  item_model_number: 'MX2D3AM/A',
  qty: '1',
  order_id: 'ORDER-A',
};
const SPLIT_LOCAL_B = {
  id: 12,
  reserved_at: '08/25/2026 12:05:05',
  item_model_number: 'MX2D3AM/A',
  qty: '1',
  order_id: 'ORDER-B',
};

test('THE BUG: a split commitment resolves to its tracker id instead of going unmatched', () => {
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [SPLIT_WEB]);
  // Both halves get the ONE web row's tracker id.
  assert.deepEqual(
    [...r.matched].sort((a, b) => a.id - b.id),
    [{ id: 11, my_tracker_id: 4901929 }, { id: 12, my_tracker_id: 4901929 }],
  );
  // And -- the part that was actually broken -- they are NOT reported as
  // unmatched. A fix that resolves them but still counts them unmatched leaves
  // the diagnostics lying about a converged backfill.
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.ambiguous, []);
});

test('the ordinary 1:1 match still resolves through the exact key, exactly once', () => {
  const web = {
    reserved_at: '2026-08-25 12:05:05',
    item_model_number: 'MX2D3AM/A',
    qty: '2',
    order_id: 'ORDER-Z',
    my_tracker_id: 777,
  };
  const local = {
    id: 5,
    reserved_at: '08/25/2026 12:05:05',
    item_model_number: 'MX2D3AM/A',
    qty: '2',
    order_id: 'ORDER-Z',
  };
  const r = resolveTrackerBackfill([local], [web]);
  assert.deepEqual(r.matched, [{ id: 5, my_tracker_id: 777 }]);
  // Guards against the split pass ALSO claiming a row the 1:1 pass took --
  // which would double-count webBackfilled and enqueue two updates for one row.
  assert.equal(r.matched.filter(m => m.id === 5).length, 1);
  assert.deepEqual(r.unmatched, []);
});

test('a local the split pass already resolved is never also reported unmatched', () => {
  // One resolvable split pair PLUS one genuinely hopeless row, together, so a
  // fix that rebuilds `unmatched` from the wrong set shows up here.
  const orphan = {
    id: 99,
    reserved_at: '2026-01-01 00:00:00',
    item_model_number: 'NOTHING/A',
    qty: '1',
    order_id: 'ORDER-Q',
  };
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B, orphan], [SPLIT_WEB]);
  const matchedIds = r.matched.map(m => m.id).sort((a, b) => a - b);
  assert.deepEqual(matchedIds, [11, 12]);
  assert.deepEqual(r.unmatched, [99]);
  // No id may appear in two buckets at once.
  for (const id of matchedIds) {
    assert.ok(!r.unmatched.includes(id), `id ${id} is both matched and unmatched`);
    assert.ok(!r.ambiguous.includes(id), `id ${id} is both matched and ambiguous`);
  }
});

test('REFUSES TO GUESS: two web rows on the same 1:1 key make the local ambiguous, not matched', () => {
  const a = {
    reserved_at: '2026-08-25 12:05:05',
    item_model_number: 'MX2D3AM/A',
    qty: '2',
    order_id: 'ORDER-Z',
    my_tracker_id: 111,
  };
  const b = { ...a, my_tracker_id: 222 };
  const local = {
    id: 8,
    reserved_at: '08/25/2026 12:05:05',
    item_model_number: 'MX2D3AM/A',
    qty: '2',
    order_id: 'ORDER-Z',
  };
  const r = resolveTrackerBackfill([local], [a, b]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.ambiguous, [8]);
  // Critically: an ambiguous row must NOT be handed to the split fallback and
  // silently resolved there. Guessing a reservation is the exact bug this
  // module already paid for once.
  assert.deepEqual(r.unmatched, []);
});

test('REFUSES TO GUESS: two candidate web rows for one split group resolve to nothing', () => {
  const twin = { ...SPLIT_WEB, my_tracker_id: 555 };
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [SPLIT_WEB, twin]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.unmatched.sort((x, y) => x - y), [11, 12]);
});

test('a split group whose qtys do not sum to any web row stays unmatched', () => {
  // 1 + 1 = 2, but the only web row is qty 3. No partial credit.
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [{ ...SPLIT_WEB, qty: '3' }]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.unmatched.sort((x, y) => x - y), [11, 12]);
});

test('a lone unmatched local is not promoted by the split pass on its own', () => {
  // group of 1 is the 1:1 path's business; the split pass must ignore it, or a
  // single qty-1 row would claim any qty-1 web row it merely resembles.
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A], [{ ...SPLIT_WEB, qty: '1' }]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.unmatched, [11]);
});

test('a web row with no usable my_tracker_id never resolves anything', () => {
  const r = resolveTrackerBackfill(
    [SPLIT_LOCAL_A, SPLIT_LOCAL_B],
    [{ ...SPLIT_WEB, my_tracker_id: null }],
  );
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.unmatched.sort((x, y) => x - y), [11, 12]);
});

test('empty inputs are inert, not a throw', () => {
  const r = resolveTrackerBackfill([], []);
  assert.deepEqual(r, { matched: [], ambiguous: [], unmatched: [] });
});

// --- WIRING ----------------------------------------------------------------
// The pure function can be perfect and the live 409 stays open if the route
// never calls it -- which is EXACTLY the defect being fixed (matchSplitGroups
// was correct and unreferenced for the whole time the bug was live). Behaviour
// tests on the helper cannot see this, so pin it structurally.
test('WIRING: the sync route actually calls resolveTrackerBackfill', () => {
  const src = readFileSync(ROUTE, 'utf8');
  // Strip comments so a mention in prose cannot satisfy the pin.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /\bresolveTrackerBackfill\s*\(/, 'route.ts never calls resolveTrackerBackfill');
  assert.match(code, /\bresolveTrackerBackfill\b[\s\S]*?from\s+['"][^'"]*bfmrJoin['"]/,
    'route.ts does not import resolveTrackerBackfill from bfmrJoin');
  // The route must consume the result, not call it and drop it on the floor.
  assert.match(code, /webBackfilled/, 'route.ts no longer reports webBackfilled');
});
