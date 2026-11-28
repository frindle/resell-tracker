import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEmailDate, earlierTime, emailDeliveredAt, emailOrderedAt, hasExplicitZone, isRetailerTime } from './orderedAt.ts';
import { parseRawOrderEmail } from './emailMessage.ts';
import { mergeEmailImportRows, type EmailRowInput } from './emailParse.ts';

const ORDER = '111-2222222-3333331';

test('a zone after the time is explicit; a bare wall-clock time is not', () => {
  assert.equal(hasExplicitZone('Sun, 15 Nov 2026 10:05:00 -0800'), true);
  assert.equal(hasExplicitZone('Sun, 15 Nov 2026 10:05:00 PST'), true);
  assert.equal(hasExplicitZone('2026-11-15 10:05 UTC'), true);
  assert.equal(hasExplicitZone('Sat, Nov 14, 2026 at 10:30 PM'), false);
  assert.equal(hasExplicitZone('Nov 13, 2026, 22:30'), false);
  assert.equal(hasExplicitZone(''), false);
});

test('chooseEmailDate: direct, forwarded with the original date, forwarded without it', () => {
  const outer = new Date('2026-11-16T04:00:00Z');
  const inner = new Date('2026-11-15T18:05:00Z');
  assert.deepEqual(chooseEmailDate({ outer, inner: '', innerParsed: null, forwarded: false }), { date: outer, source: 'direct' });
  assert.deepEqual(chooseEmailDate({ outer, inner: 'Sun, 15 Nov 2026 10:05:00 -0800', innerParsed: inner, forwarded: true }), { date: inner, source: 'forwarded-original' });
  assert.deepEqual(chooseEmailDate({ outer, inner: 'Nov 15, 2026, 10:05', innerParsed: inner, forwarded: true }), { date: inner, source: 'forwarded-unzoned' });
  // Nothing readable inside the forward: the date is the forward's own.
  assert.deepEqual(chooseEmailDate({ outer, inner: '', innerParsed: null, forwarded: true }), { date: outer, source: 'forward-time' });
  // An original date later than the forward is nonsense: the forward's time, flagged as such.
  const later = new Date('2026-12-30T00:00:00Z');
  assert.deepEqual(chooseEmailDate({ outer, inner: 'Wed, 30 Dec 2026 00:00:00 +0000', innerParsed: later, forwarded: true }), { date: outer, source: 'forward-time' });
  assert.equal(chooseEmailDate({ outer: undefined, inner: '', innerParsed: null, forwarded: false }).date, undefined);
});

test('only direct and zoned original times are the retailer\'s', () => {
  assert.deepEqual((['direct', 'forwarded-original', 'forwarded-unzoned', 'forward-time', undefined] as const).map(isRetailerTime), [true, true, false, false, false]);
});

test('emailOrderedAt: order-placed emails only, never undated, never a forward\'s own time', () => {
  const base = { kind: 'ordered', date: '2026-11-15T18:05:00.000Z', dateSource: 'direct' as const };
  assert.equal(emailOrderedAt(base), '2026-11-15T18:05:00.000Z');
  assert.equal(emailOrderedAt({ ...base, dateSource: 'forwarded-original' }), '2026-11-15T18:05:00.000Z');
  for (const kind of ['shipped', 'delivered', 'cancelled', 'delayed', 'other']) assert.equal(emailOrderedAt({ ...base, kind }), null, kind);
  assert.equal(emailOrderedAt({ ...base, undated: true }), null);
  assert.equal(emailOrderedAt({ ...base, dateSource: 'forward-time' }), null);
  assert.equal(emailOrderedAt({ ...base, dateSource: 'forwarded-unzoned' }), null);
  assert.equal(emailOrderedAt({ ...base, dateSource: undefined }), null);
  assert.equal(emailOrderedAt({ ...base, date: 'not a date' }), null);
  // The eGift delivery time follows the same trust rule, for any email kind.
  assert.equal(emailDeliveredAt({ date: base.date, dateSource: 'direct' }), base.date);
  assert.equal(emailDeliveredAt({ date: base.date, dateSource: 'forward-time' }), null);
});

test('earlierTime fills an empty column or moves it earlier, never later', () => {
  const a = new Date('2026-11-15T18:05:00Z');
  assert.deepEqual(earlierTime(null, '2026-11-15T19:00:00Z'), new Date('2026-11-15T19:00:00Z'));
  assert.deepEqual(earlierTime(undefined, '2026-11-15T19:00:00Z'), new Date('2026-11-15T19:00:00Z'));
  assert.deepEqual(earlierTime(a, '2026-11-15T17:00:00Z'), new Date('2026-11-15T17:00:00Z'));
  assert.equal(earlierTime(a, '2026-11-15T19:00:00Z'), undefined);
  assert.equal(earlierTime(a, a.toISOString()), undefined);
  assert.equal(earlierTime(a, undefined), undefined);
  assert.equal(earlierTime(a, 'garbage'), undefined);
  assert.equal(earlierTime(null, 'garbage'), undefined);
});

test('merged import rows carry the earliest order-placed time, and only from ordered emails', () => {
  const row = (kind: EmailRowInput['kind'], orderedAt?: string): EmailRowInput => ({
    kind, platform: 'Amazon', orderNumber: ORDER, orderDate: '2026-11-15T20:00:00.000Z', ...(orderedAt ? { orderedAt } : {}),
    itemDescription: 'Widget', cost: 10, shippingCost: 0, salePrice: null, buyerId: '', cardId: '', cashbackAmount: 0,
  });
  const merged = mergeEmailImportRows([row('ordered', '2026-11-15T19:00:00.000Z'), row('ordered', '2026-11-15T18:05:00.000Z'), row('shipped')]);
  assert.equal(merged.rows[0].orderedAt, '2026-11-15T18:05:00.000Z');
  assert.equal(mergeEmailImportRows([row('ordered'), row('shipped')]).rows[0].orderedAt, undefined);
});

// ---- the whole message: direct mail, and forwards with and without the original time ----

const BODY = `Order # ${ORDER}\nShip to\nSAM EXAMPLE\n100 TEST ST\nSPRINGFIELD, ZZ 00001\n\nOrder Total: $20.00`;
function raw(from: string, subject: string, date: string, body: string) {
  return [
    `From: ${from}`, 'To: sam@orders.example.test', `Subject: ${subject}`, `Date: ${date}`,
    'Message-ID: <t-1@home.example.test>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\r\n');
}
const PERSON = 'Sam <sam@home.example.test>';
const FORWARD_AT = 'Sun, 15 Nov 2026 20:00:00 -0800'; // 2026-11-16T04:00Z

test('direct order email: its own Date is the order time', async () => {
  const r = await parseRawOrderEmail(raw('Amazon.com <auto-confirm@amazon.com>', 'Ordered: "Widget"', 'Sun, 15 Nov 2026 10:05:00 -0800', BODY), 1);
  assert.ok(r);
  assert.equal(r.dateSource, 'direct');
  assert.equal(emailOrderedAt(r), '2026-11-15T18:05:00.000Z');
});

test('forward with the original Date (and zone): the original is used, not the forward time', async () => {
  const fwd = `---------- Forwarded message ---------\nFrom: Amazon.com <auto-confirm@amazon.com>\nDate: Sun, 15 Nov 2026 10:05:00 -0800\nSubject: Ordered: "Widget"\nTo: Sam <sam@orders.example.test>\n\n${BODY}`;
  const r = await parseRawOrderEmail(raw(PERSON, 'Fwd: Ordered: "Widget"', FORWARD_AT, fwd), 2);
  assert.ok(r);
  assert.equal(r.forwarded, true);
  assert.equal(r.dateSource, 'forwarded-original');
  assert.equal(r.date, '2026-11-15T18:05:00.000Z');
  assert.equal(emailOrderedAt(r), '2026-11-15T18:05:00.000Z');
});

test('forward whose original Date has no zone: the date is kept for display but no order time is set', async () => {
  const fwd = `---------- Forwarded message ---------\nFrom: Amazon.com <auto-confirm@amazon.com>\nDate: Sun, Nov 15, 2026 at 10:05 AM\nSubject: Ordered: "Widget"\nTo: Sam <sam@orders.example.test>\n\n${BODY}`;
  const r = await parseRawOrderEmail(raw(PERSON, 'Fwd: Ordered: "Widget"', FORWARD_AT, fwd), 3);
  assert.ok(r);
  assert.equal(r.dateSource, 'forwarded-unzoned');
  assert.equal(emailOrderedAt(r), null);
});

test('forward with no original Date: only the forward time exists, so no order time is set', async () => {
  const fwd = `---------- Forwarded message ---------\nFrom: Amazon.com <auto-confirm@amazon.com>\nSubject: Ordered: "Widget"\nTo: Sam <sam@orders.example.test>\n\n${BODY}`;
  const r = await parseRawOrderEmail(raw(PERSON, 'Fwd: Ordered: "Widget"', FORWARD_AT, fwd), 4);
  assert.ok(r);
  assert.equal(r.dateSource, 'forward-time');
  assert.equal(r.date, '2026-11-16T04:00:00.000Z');
  assert.equal(emailOrderedAt(r), null);
});

test('a Fwd: whose block cannot be unwrapped is still a forward', async () => {
  const r = await parseRawOrderEmail(raw(PERSON, 'Fwd: Ordered: "Widget"', FORWARD_AT, BODY), 5);
  assert.ok(r);
  assert.equal(r.dateSource, 'forward-time');
  assert.equal(emailOrderedAt(r), null);
});
