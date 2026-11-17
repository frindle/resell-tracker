import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestLines, lineLooksPrivate, dayWindow, daysToPost, postDigestLines, MAX_LINES, type DigestCounts } from './digestLines.ts';

const none: DigestCounts = {
  ordersAdded: {}, addedWithoutCard: 0, syncRuns: 0, syncOrdersChanged: 0,
  cardsSubmitted: 0, waitingToShip: 0, pastShipBy: 0, unseenErrors: 0,
};

test('a quiet day is one line and does not need Penn', () => {
  assert.deepEqual(buildDigestLines(none), { lines: ['No new orders.'], needsYou: false });
});

test('a busy day lists each count once, biggest platform first', () => {
  const { lines, needsYou } = buildDigestLines({
    ordersAdded: { Lenovo: 1, Walmart: 3, Amazon: 0 }, addedWithoutCard: 2, syncRuns: 12, syncOrdersChanged: 9,
    cardsSubmitted: 4, waitingToShip: 3, pastShipBy: 0, unseenErrors: 5,
  });
  assert.deepEqual(lines, [
    '4 new orders (Walmart 3, Lenovo 1).',
    '2 new orders with no card set.',
    'Order syncs: 12 runs, 9 orders added or updated.',
    '4 gift cards submitted to CardCenter.',
    'Waiting on tracking: 3 orders.',
    'Unread API errors: 5.',
  ]);
  assert.equal(needsYou, false);
});

test('singular wording and a single platform', () => {
  const { lines } = buildDigestLines({ ...none, ordersAdded: { Walmart: 1 }, syncRuns: 1, syncOrdersChanged: 1, cardsSubmitted: 1 });
  assert.deepEqual(lines, ['1 new order (Walmart).', 'Order syncs: 1 run, 1 order added or updated.', '1 gift card submitted to CardCenter.']);
});

test('an order past its ship-by date needs Penn', () => {
  const { lines, needsYou } = buildDigestLines({ ...none, waitingToShip: 3, pastShipBy: 1 });
  assert.ok(lines.includes('Waiting on tracking: 3 orders, 1 past the ship-by date.'));
  assert.equal(needsYou, true);
});

test('a line the queue would call private is rewritten or dropped, not sent', () => {
  // The queue refuses these (its rule, case-insensitive).
  for (const l of [
    'Order 2000157 shipped', 'paid $40', 'mail me@x', 'cost £5', 'cost €5', '¥300', '5¢ fee',
    'refund 12.50', 'refund 12,50', 'count 1,00', 'paid 40 USD', 'in eur', '3 Dollars', 'one dollar',
    'x (12.50)', '١٢٣٤٥٦',
  ]) assert.equal(lineLooksPrivate(l), true, l);
  // And lets these through.
  for (const l of [
    '12 runs, 99999 orders', 'count 1,000', 'v1.5 shipped', '12.5 hours', 'item12.50', '12.50x',
    'usdc', 'dollarstore', 'Euro shop', 'No new orders.', 'Order syncs: 3 runs, 12 orders added or updated.',
  ]) assert.equal(lineLooksPrivate(l), false, l);
  // A platform name the queue would refuse drops the breakdown, keeps the count.
  assert.deepEqual(buildDigestLines({ ...none, ordersAdded: { 'Shop 1234567': 2 } }).lines, ['2 new orders.']);
  assert.deepEqual(buildDigestLines({ ...none, ordersAdded: { 'A@b': 1, Walmart: 2 } }).lines, ['3 new orders.']);
  for (const l of buildDigestLines({ ...none, ordersAdded: { 'Gift $ shop': 1 }, syncRuns: 2, syncOrdersChanged: 5 }).lines) {
    assert.equal(lineLooksPrivate(l), false, l);
  }
});

test('a line is tested as cut, so a cut never ends on a refused word', () => {
  // [kept by the cut, cut off]: the whole name is clear, the cut ends on a refused word or amount.
  for (const [kept, rest] of [[' Eur', 'ostar'], [' dollar', 'store'], [' usd', 'c shop'], [' 12.50', '5']]) {
    const head = '1 new order (';
    const name = 'x'.repeat(200 - head.length - kept.length) + kept + rest;
    const full = `${head}${name}).`;
    assert.equal(lineLooksPrivate(full), false, full);
    assert.equal(lineLooksPrivate(full.slice(0, 200)), true, kept);
    const tail = kept + rest;
    const { lines } = buildDigestLines({ ...none, ordersAdded: { [name]: 1 } });
    for (const l of lines) {
      assert.ok(Array.from(l).length <= 200, l);
      assert.equal(lineLooksPrivate(l), false, l);
    }
    assert.deepEqual(lines, ['1 new order.'], tail);
  }
  // A platform that stays clear when cut keeps its breakdown.
  assert.deepEqual(buildDigestLines({ ...none, ordersAdded: { Walmart: 1 } }).lines, ['1 new order (Walmart).']);
});

test('a cut never splits a surrogate pair', () => {
  const { lines } = buildDigestLines({ ...none, ordersAdded: { ['x'.repeat(186) + '\u{1F600}'.repeat(20)]: 1 } });
  for (const l of lines) {
    assert.ok(Array.from(l).length <= 200);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l), false);
  }
});

test('never more than the queue allows', () => {
  const { lines } = buildDigestLines({ ...none, ordersAdded: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`P${String.fromCharCode(65 + (i % 26))}${i}`, 1])) });
  assert.ok(lines.length <= MAX_LINES);
  for (const l of lines) assert.ok(Array.from(l).length <= 200);
});

// All instants are UTC, so these hold whatever TZ the test process runs in.
test('day windows are LA calendar days', () => {
  const now = new Date(Date.UTC(2026, 10, 16, 11, 30)); // 03:30 LA, Nov 16
  assert.deepEqual(dayWindow(now, 0), { day: '2026-11-16', start: new Date(Date.UTC(2026, 10, 16, 8)), end: new Date(Date.UTC(2026, 10, 17, 8)) });
  assert.equal(dayWindow(now, 1).day, '2026-11-15');
  assert.equal(dayWindow(new Date(Date.UTC(2026, 10, 16, 7, 59)), 0).day, '2026-11-15'); // 23:59 LA
  assert.equal(dayWindow(new Date(Date.UTC(2026, 0, 1, 9)), 1).day, '2025-12-31');
});

test('DST days are 25 and 23 hours long', () => {
  const fall = dayWindow(new Date(Date.UTC(2026, 10, 1, 20)), 0); // Nov 1 2026, clocks go back
  assert.deepEqual([fall.start, fall.end], [new Date(Date.UTC(2026, 10, 1, 7)), new Date(Date.UTC(2026, 10, 2, 8))]);
  const spring = dayWindow(new Date(Date.UTC(2026, 2, 8, 20)), 0); // Mar 8 2026, clocks go forward
  assert.deepEqual([spring.start, spring.end], [new Date(Date.UTC(2026, 2, 8, 8)), new Date(Date.UTC(2026, 2, 9, 7))]);
});

test('yesterday is re-posted only until the digest has run', () => {
  assert.deepEqual(daysToPost(new Date(Date.UTC(2026, 10, 16, 8, 5))), [1, 0]); // 00:05 LA
  assert.deepEqual(daysToPost(new Date(Date.UTC(2026, 10, 16, 13, 59))), [1, 0]); // 05:59
  assert.deepEqual(daysToPost(new Date(Date.UTC(2026, 10, 16, 14, 0))), [0]); // 06:00
  assert.deepEqual(daysToPost(new Date(Date.UTC(2026, 10, 17, 7, 0))), [0]); // 23:00
});

function fakeFetch(status: number, body = '') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('the POST matches the queue contract', async () => {
  const f = fakeFetch(200, '{"ok":true}');
  const r = await postDigestLines('2026-11-15', ['No new orders.'], true, { url: 'http://q:7684/', token: 'tok' }, f.fn);
  assert.equal(r.result, 'sent');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://q:7684/api/digest-lines');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(f.calls[0].init.headers, { Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { app: 'resell', day: '2026-11-15', lines: ['No new orders.'], needs_you: true });
});

test('no env, an older queue or a queue without its key is skipped quietly', async () => {
  const f = fakeFetch(200);
  assert.equal((await postDigestLines('2026-11-15', [], false, { url: 'http://q' }, f.fn)).result, 'skipped');
  assert.equal((await postDigestLines('2026-11-15', [], false, { token: 't' }, f.fn)).result, 'skipped');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await postDigestLines('2026-11-15', [], false, { url: 'http://q', token: 't' }, fakeFetch(404).fn), { result: 'skipped', status: 404 });
  assert.deepEqual(await postDigestLines('2026-11-15', [], false, { url: 'http://q', token: 't' }, fakeFetch(503).fn), { result: 'skipped', status: 503 });
});

test('a rejected or unreachable POST is reported, never thrown', async () => {
  assert.deepEqual(
    await postDigestLines('2026-11-15', [], false, { url: 'http://q', token: 't' }, fakeFetch(400, '{"error":"line 1 looks private"}').fn),
    { result: 'failed', status: 400, error: '{"error":"line 1 looks private"}' },
  );
  const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
  assert.deepEqual(await postDigestLines('2026-11-15', [], false, { url: 'http://q', token: 't' }, down), { result: 'failed', error: 'connect ECONNREFUSED' });
});
