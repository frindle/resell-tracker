// Adversarial cases for the web-backfill resolution pass.
//
// THE CONFIRMED DEFECT: matchSplitGroups() landed in bf4ca57 and resolves
// split commitments correctly, but NOTHING CALLS IT. The sync route still
// runs only the 1:1 bfmrJoinKey pass, so every half of a split commitment
// falls into `unmatched`, keeps myTrackerId null forever, and every tracking
// submit for it 409s.
//
// These cases pin the WHOLE backfill decision -- row normalization, the 1:1
// pass, the split fallback, the refusal to guess, and the exact write plan the
// route has to execute -- behind two pure functions, plus a structural pin
// that the route actually calls them. Everything the route does with the
// result is asserted HERE, because the route itself cannot be driven without
// standing up Prisma and a headless BFMR login.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BACKFILL_KEY_SAMPLES, bfmrJoinKey, normalizeBackfillLocal, resolveTrackerBackfill } from './bfmrJoin';
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

const sortNums = (a: number[]) => [...a].sort((x, y) => x - y);
const sortUpd = (a: Array<{ id: number; myTrackerId: number }>) =>
  [...a].sort((x, y) => x.id - y.id);

// --- normalization ---------------------------------------------------------
// reserved_at and item_model_number exist ONLY inside the raw JSON blob. If
// this reshaping is wrong, every key is wrong and the backfill silently
// resolves nothing -- which is indistinguishable from "no matches exist".

test('normalize: reserved_at and item_model_number are read out of the raw JSON blob', () => {
  const n = normalizeBackfillLocal({
    id: 3,
    raw: JSON.stringify({
      reserved_at: '08/25/2026 12:05:05',
      item_model_number: 'MX2D3AM/A',
      item_name: 'iPhone',
    }),
    itemName: 'column name',
    qty: '2',
    bfmrOrderId: 'ORDER-Z',
  });
  assert.equal(n.id, 3);
  assert.equal(n.reserved_at, '08/25/2026 12:05:05');
  assert.equal(n.item_model_number, 'MX2D3AM/A');
  assert.equal(n.item_name, 'iPhone');      // raw wins over the column
  assert.equal(n.qty, '2');
  assert.equal(n.order_id, 'ORDER-Z');      // from bfmrOrderId, not `order_id`
});

test('normalize: unparseable or absent raw degrades to a non-matching key, never throws', () => {
  for (const raw of ['{not json', null, undefined, '']) {
    const n = normalizeBackfillLocal({
      id: 4, raw: raw as string | null, itemName: 'fallback name', qty: '1', bfmrOrderId: null,
    });
    assert.equal(n.reserved_at, undefined);
    assert.equal(n.item_model_number, undefined);
    assert.equal(n.item_name, 'fallback name');   // the column is the fallback
    assert.equal(n.order_id, null);
  }
});

test('normalize: a normalized row actually resolves end-to-end against a web row', () => {
  // Proves the reshaping produces keys the resolver can USE -- not merely that
  // fields were copied. A field renamed in normalize alone would pass the two
  // cases above and fail here.
  const local = normalizeBackfillLocal({
    id: 7,
    raw: JSON.stringify({ reserved_at: '08/25/2026 12:05:05', item_model_number: 'MX2D3AM/A' }),
    itemName: null, qty: '2', bfmrOrderId: 'ORDER-Z',
  });
  const r = resolveTrackerBackfill([local], [{ ...SPLIT_WEB, order_id: 'ORDER-Z', my_tracker_id: 777 }]);
  assert.deepEqual(r.matchedUpdates, [{ id: 7, myTrackerId: 777 }]);
});

// --- the defect ------------------------------------------------------------

test('THE BUG: a split commitment resolves to its tracker id instead of going unmatched', () => {
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [SPLIT_WEB]);
  assert.deepEqual(sortUpd(r.matchedUpdates), [
    { id: 11, myTrackerId: 4901929 },
    { id: 12, myTrackerId: 4901929 },
  ]);
  // And -- the part that was actually broken -- they are NOT left to be
  // stamped-and-forgotten. A fix that resolves them but still counts them
  // unmatched leaves the diagnostics lying about a converged backfill.
  assert.deepEqual(r.stampIds, []);
  assert.deepEqual(r.counts, { backfilled: 2, ambiguous: 0, unmatched: 0 });
});

test('the ordinary 1:1 match still resolves through the exact key, exactly once', () => {
  const web = {
    reserved_at: '2026-08-25 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z', my_tracker_id: 777,
  };
  const local = {
    id: 5, reserved_at: '08/25/2026 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z',
  };
  const r = resolveTrackerBackfill([local], [web]);
  assert.deepEqual(r.matchedUpdates, [{ id: 5, myTrackerId: 777 }]);
  // Guards against the split pass ALSO claiming a row the 1:1 pass took --
  // which would double-count and enqueue two updates for one row.
  assert.equal(r.matchedUpdates.filter(m => m.id === 5).length, 1);
  assert.deepEqual(r.stampIds, []);
});

test('a local the split pass resolved is never also queued for a stamp-only write', () => {
  const orphan = {
    id: 99, reserved_at: '2026-01-01 00:00:00', item_model_number: 'NOTHING/A',
    qty: '1', order_id: 'ORDER-Q',
  };
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B, orphan], [SPLIT_WEB]);
  assert.deepEqual(sortNums(r.matchedUpdates.map(m => m.id)), [11, 12]);
  assert.deepEqual(r.stampIds, [99]);
  for (const m of r.matchedUpdates) {
    assert.ok(!r.stampIds.includes(m.id), `id ${m.id} is both matched and stamp-only`);
  }
  assert.deepEqual(r.counts, { backfilled: 2, ambiguous: 0, unmatched: 1 });
});

// --- refusing to guess -----------------------------------------------------

test('REFUSES TO GUESS: two web rows on the same 1:1 key make the local ambiguous, not matched', () => {
  const a = {
    reserved_at: '2026-08-25 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z', my_tracker_id: 111,
  };
  const b = { ...a, my_tracker_id: 222 };
  const local = {
    id: 8, reserved_at: '08/25/2026 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z',
  };
  const r = resolveTrackerBackfill([local], [a, b]);
  assert.deepEqual(r.matchedUpdates, []);
  assert.deepEqual(r.stampIds, [8]);
  // An ambiguous row must be counted as ambiguous, not quietly folded into
  // unmatched -- and must NOT be handed to the split fallback and resolved
  // there. Guessing a reservation is the exact bug this module already paid
  // for once.
  assert.deepEqual(r.counts, { backfilled: 0, ambiguous: 1, unmatched: 0 });
});

test('REFUSES TO GUESS: two candidate web rows for one split group resolve to nothing', () => {
  const twin = { ...SPLIT_WEB, my_tracker_id: 555 };
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [SPLIT_WEB, twin]);
  assert.deepEqual(r.matchedUpdates, []);
  assert.deepEqual(sortNums(r.stampIds), [11, 12]);
  assert.deepEqual(r.counts, { backfilled: 0, ambiguous: 0, unmatched: 2 });
});

test('a split group whose qtys do not sum to any web row stays unmatched', () => {
  // 1 + 1 = 2, but the only web row is qty 3. No partial credit.
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [{ ...SPLIT_WEB, qty: '3' }]);
  assert.deepEqual(r.matchedUpdates, []);
  assert.deepEqual(sortNums(r.stampIds), [11, 12]);
});

test('a lone unmatched local is not promoted by the split pass on its own', () => {
  // A group of 1 is the 1:1 path's business; the split pass must ignore it, or
  // a single qty-1 row would claim any qty-1 web row it merely resembles.
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A], [{ ...SPLIT_WEB, qty: '1' }]);
  assert.deepEqual(r.matchedUpdates, []);
  assert.deepEqual(r.stampIds, [11]);
});

test('a web row with no usable my_tracker_id never resolves anything', () => {
  for (const bad of [null, undefined, 0, '']) {
    const r = resolveTrackerBackfill(
      [SPLIT_LOCAL_A, SPLIT_LOCAL_B],
      [{ ...SPLIT_WEB, my_tracker_id: bad as unknown }],
    );
    assert.deepEqual(r.matchedUpdates, [], `my_tracker_id ${String(bad)} must not resolve`);
    assert.deepEqual(sortNums(r.stampIds), [11, 12]);
  }
});

test('empty inputs are inert, not a throw', () => {
  const r = resolveTrackerBackfill([], []);
  assert.deepEqual(r.matchedUpdates, []);
  assert.deepEqual(r.stampIds, []);
  assert.deepEqual(r.counts, { backfilled: 0, ambiguous: 0, unmatched: 0 });
});


test('an EXACT 1:1 hit whose my_tracker_id is unusable must not be treated as matched', () => {
  // The previous cases only ever fed a bad my_tracker_id to rows that had ZERO
  // 1:1 hits, so the "exactly one hit AND the id is usable" conjunction was
  // never actually tested as a conjunction -- mutating that `&&` to `||`
  // survived. Each of these has exactly ONE key-matching web row.
  const local = {
    id: 21, reserved_at: '08/25/2026 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z',
  };
  const base = {
    reserved_at: '2026-08-25 12:05:05', item_model_number: 'MX2D3AM/A',
    qty: '2', order_id: 'ORDER-Z',
  };
  for (const bad of [null, undefined, 0, '', 'not-a-number', -5, NaN]) {
    const r = resolveTrackerBackfill([local], [{ ...base, my_tracker_id: bad as unknown }]);
    assert.deepEqual(r.matchedUpdates, [], `my_tracker_id ${String(bad)} must not resolve`);
    assert.deepEqual(r.stampIds, [21], `my_tracker_id ${String(bad)} must still be stamped`);
    assert.deepEqual(r.counts, { backfilled: 0, ambiguous: 0, unmatched: 1 });
  }
  // ...and the same row with a usable id DOES resolve, so the cases above are
  // failing for the right reason rather than on a broken fixture.
  const ok = resolveTrackerBackfill([local], [{ ...base, my_tracker_id: 909 }]);
  assert.deepEqual(ok.matchedUpdates, [{ id: 21, myTrackerId: 909 }]);
});

test('the reported key samples are the keys the resolver actually joined on', () => {
  // These are the ONLY signal distinguishing "the web surface returned rows but
  // nothing matched" from "the login broke and we swallowed it" -- a real past
  // incident. If they are computed from a different shape than the join uses,
  // they are worse than absent: they corroborate a wrong diagnosis.
  const r = resolveTrackerBackfill([SPLIT_LOCAL_A, SPLIT_LOCAL_B], [SPLIT_WEB]);
  assert.deepEqual(r.samples.web, [bfmrJoinKey(SPLIT_WEB)]);
  assert.deepEqual(r.samples.local, [bfmrJoinKey(SPLIT_LOCAL_A), bfmrJoinKey(SPLIT_LOCAL_B)]);
  // Non-empty and genuinely key-shaped, not a stringified object.
  assert.ok(r.samples.local[0].includes('|'), 'a join key is pipe-delimited');
});

test('key samples are capped so a 748-row account cannot bloat the response', () => {
  const many = Array.from({ length: BACKFILL_KEY_SAMPLES + 7 }, (_, i) => ({
    id: 1000 + i, reserved_at: `2026-08-2${i % 9} 12:05:05`,
    item_model_number: `M-${i}`, qty: '1', order_id: `O-${i}`,
  }));
  const r = resolveTrackerBackfill(many, many.map(m => ({ ...m, my_tracker_id: 1 })));
  // Pinned to the LITERAL 5, not to BACKFILL_KEY_SAMPLES: asserting the cap
  // against the constant it caps is self-referential and cannot fail -- change
  // the constant and both sides move together.
  assert.equal(BACKFILL_KEY_SAMPLES, 5, 'the sample cap is 5');
  assert.equal(r.samples.local.length, 5);
  assert.equal(r.samples.web.length, 5);
  assert.ok(5 < many.length, 'the cap must actually bind in this case');
});

// --- WIRING ----------------------------------------------------------------
// The pure functions can be perfect and the live 409 stays open if the route
// never calls them -- which is EXACTLY the defect being fixed (matchSplitGroups
// was correct and unreferenced for the whole time the bug was live). Behaviour
// tests on the helpers cannot see this, so pin it structurally.

test('WIRING: the sync route calls both helpers and consumes the result', () => {
  const src = readFileSync(ROUTE, 'utf8');
  // Strip comments so a mention in prose cannot satisfy the pin.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /from\s+['"][^'"]*bfmrJoin['"]/, 'route.ts does not import from bfmrJoin');
  // Now drop the import statements. Everything below must hold in the BODY:
  // a name that survives only in an import is not a call site, and counting it
  // as one is how deleting the actual wiring goes unnoticed.
  const body = code.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]*['"];?\s*$/gm, '');
  assert.match(body, /\bresolveTrackerBackfill\s*\(/, 'route.ts never calls resolveTrackerBackfill');
  assert.match(body, /\.map\(\s*normalizeBackfillLocal\s*\)/,
    'route.ts does not map needsWebBackfill through normalizeBackfillLocal');
  assert.match(body, /webKeySamples\.push\(\s*\.\.\.\s*samples\.web\s*\)/,
    'route.ts does not report the resolver\'s web key samples');
  assert.match(body, /localKeySamples\.push\(\s*\.\.\.\s*samples\.local\s*\)/,
    'route.ts does not report the resolver\'s local key samples');
  // It must consume the plan, not call it and drop it on the floor.
  for (const token of ['matchedUpdates', 'stampIds', 'webBackfilled', 'webAmbiguous',
    'webUnmatched', 'webKeySamples', 'localKeySamples']) {
    assert.match(body, new RegExp(`\\b${token}\\b`), `route.ts no longer uses ${token}`);
  }
  // Each counter must be fed from the resolver's tally, not left at its
  // initial 0 -- a fix that resolves splits but reports 0 backfilled is how
  // this stayed invisible for as long as it did.
  for (const [counter, field] of [['webBackfilled', 'backfilled'],
    ['webAmbiguous', 'ambiguous'], ['webUnmatched', 'unmatched']] as const) {
    assert.match(body, new RegExp(`${counter}\\s*=\\s*counts\\.${field}\\b`),
      `route.ts does not set ${counter} from counts.${field}`);
  }
  // The old inline classification must be GONE -- leaving it in place beside a
  // new call is how a "fix" ships that changes nothing.
  assert.doesNotMatch(body, /\bbyKey\b/, 'route.ts still builds its own inline join index');
});
