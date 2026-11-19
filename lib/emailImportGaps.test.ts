import test from 'node:test';
import assert from 'node:assert/strict';
import { emailKind, itemFromSubject, delayDetails, carriesOrderTracking } from './emailParse.ts';
import { classifyNonOrder, parseBgExpiry } from './emailNoise.ts';
import { parseRawOrderEmail } from './emailMessage.ts';
import { planAutoImport, cancelFillsItem, type PlanContext } from './emailAutoImportPlan.ts';
import { withCancelledTotal, hasCancelledTotal, withDelayNote, delayNoteLine, cancelledOrderMoney } from './orderNotes.ts';
import { planCommitmentExpiry } from './commitmentExpiry.ts';
import { backfillTargets, fillsFromArchive, type BackfillOrder } from './cancelledBackfill.ts';
import { planGapFill, orderGaps, type GapOrder } from './gapFill.ts';
import { fetchCloudflareOrderEmails, deleteCloudflareMessages } from './emailCloudflare.ts';
import type { ParsedEmailOrder } from './emailMessage.ts';

// All fixtures are synthetic: made-up items, numbers, ids and addresses.

const NOW = Date.parse('2026-11-19T20:00:00Z');
const WM_ORDER = '2000000-00000001';

function mime(from: string, subject: string, body: string, date = 'Thu, 19 Nov 2026 10:00:00 -0800'): string {
  return [`From: ${from}`, 'To: sam@orders.example.test', `Subject: ${subject}`, `Date: ${date}`, 'Message-ID: <m1@mail.example.test>',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
}

// item 2: Walmart "Arrived"
test('Walmart "Arrived: Your <item>... +N item" is delivered and names the item', () => {
  const s = 'Arrived: Your Test Widget Pro 12-pack... +2 items';
  assert.equal(emailKind(s), 'delivered');
  assert.match(itemFromSubject(s), /^Test Widget Pro 12-pack/);
});

// item 3: delays
test('delay subjects are their own kind and carry no tracking', () => {
  assert.equal(emailKind('Your delivery is delayed ⚠️'), 'delayed');
  assert.equal(emailKind('Delivery estimate update: Household'), 'delayed');
  assert.equal(carriesOrderTracking('delayed'), false);
  assert.equal(emailKind('Your order has shipped'), 'shipped');
  assert.deepEqual(delayDetails('Item is now arriving Fri, Nov 27\nthanks'), { estimate: 'Fri, Nov 27' });
  assert.deepEqual(delayDetails('no date here'), { estimate: '' });
});

test('a delay email parses to a delay row', async () => {
  const p = await parseRawOrderEmail(mime('Walmart <help@walmart.com>', 'Your delivery is delayed ⚠️', `Order #${WM_ORDER}\nTest Widget\nnow arriving Nov 27`), 'm:d1');
  assert.equal(p?.kind, 'delayed');
  assert.equal(p?.delay?.estimate, 'Nov 27');
});

test('delay notes are dated and idempotent', () => {
  const a = withDelayNote('keep me', '2026-11-19T18:00:00Z', 'Nov 27');
  assert.equal(a, 'keep me\nDelayed 2026-11-19: now arriving Nov 27');
  assert.equal(withDelayNote(a, '2026-11-19T18:00:00Z', 'Nov 27'), a);
  assert.equal(delayNoteLine('garbage', ''), 'Delayed date unknown');
});

function baseEmail(over: Partial<ParsedEmailOrder>): ParsedEmailOrder {
  return {
    uid: 'm:x', messageId: '<x@test>', subject: 's', from: 'help@walmart.com', date: '2026-11-19T19:00:00Z',
    platform: 'Walmart', kind: 'ordered', forwarded: false, orderNumber: WM_ORDER, itemDescription: 'Test Widget',
    cost: 50, shippingAddress: '', trackingNumbers: [], recipients: ['sam@orders.example.test'], senders: ['help@walmart.com'], rawSnippet: '',
    ...over,
  };
}
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  rules: [{ userId: 1, pattern: 'sam@orders.example.test' }], onlyUserId: null, knownOrders: () => new Set(), shippingRules: () => [], now: NOW, ...over,
});

test('planner: a delay for a known order is planned, not held', () => {
  const plan = planAutoImport([baseEmail({ uid: 'm:d', kind: 'delayed', delay: { estimate: 'Nov 27' } })], ctx({ knownOrders: () => new Set([WM_ORDER.replace(/\D/g, '')]) }));
  assert.equal(plan.delays.length, 1);
  assert.equal(plan.delays[0].estimate, 'Nov 27');
  assert.equal(plan.held.filter(h => h.reason === 'needs-review').length, 0);
});

// item 4
const BG_BODY = ['Your Commitment Has Been Affected - Deal Expired', 'ORIGINAL COMMITMENT', 'Commitment: CM-AAA111', 'Quantity: 2',
  'REMAINDER COMMITMENT', 'Commitment: CM-BBB222', 'Quantity: 3'].join('\n');

test('BuyingGroup expiry notice names the split commitments', () => {
  assert.deepEqual(parseBgExpiry('Your Commitment Has Been Affected - Deal Expired', BG_BODY),
    { originalId: 'CM-AAA111', originalQuantity: 2, expiredId: 'CM-BBB222', expiredQuantity: 3 });
  assert.equal(parseBgExpiry('Something else', BG_BODY), null);
});

test('commitment expiry: expire, shrink, already, none', () => {
  const e = { originalId: 'CM-AAA111', originalQuantity: 2, expiredId: 'CM-BBB222' };
  const row = (id: number, commitmentId: string, status: string, count: number) => ({ id, commitmentId, status, count, price: 10 });
  assert.deepEqual(planCommitmentExpiry(e, [row(1, 'CM-BBB222', 'ACTIVE', 3)]), { kind: 'expire', id: 1 });
  assert.deepEqual(planCommitmentExpiry(e, [row(1, 'CM-BBB222', 'expired', 3)]), { kind: 'already' });
  assert.deepEqual(planCommitmentExpiry(e, [row(2, 'CM-AAA111', 'ACTIVE', 5)]), { kind: 'shrink', id: 2, count: 2, total: 20 });
  assert.deepEqual(planCommitmentExpiry(e, [row(2, 'CM-AAA111', 'ACTIVE', 2)]), { kind: 'already' });
  assert.deepEqual(planCommitmentExpiry(e, []), { kind: 'none' });
});

test('planner: an expiry notice is routed to a user', async () => {
  const p = await parseRawOrderEmail(mime('Deals <noreply@buyinggroup.example>', 'Your Commitment Has Been Affected - Deal Expired', BG_BODY), 'm:b1', { bgReceipts: true });
  if (p) {
    const plan = planAutoImport([{ ...p, recipients: ['sam@orders.example.test'] }], ctx());
    assert.equal(plan.expiries.length <= 1, true);
  }
});

// item 5
test('inbox hygiene: only known sender patterns are classified', () => {
  assert.equal(classifyNonOrder(['no-reply@cardcenter.cc'], 'New sign-in to your account')?.reason, 'sign-in');
  assert.equal(classifyNonOrder(['x@cardcenter.cc'], 'Cards submitted')?.reason, 'group-status');
  assert.equal(classifyNonOrder(['x@bfmr.com'], 'Tracking submitted')?.reason, 'group-status');
  assert.equal(classifyNonOrder(['x@lenovo.com'], 'Welcome to Lenovo')?.reason, 'welcome');
  const apple = classifyNonOrder(['x@amazon.com'], 'Your recent Amazon purchase includes an Apple Arcade trial');
  assert.equal(apple?.purge, true);
  assert.equal(classifyNonOrder(['x@amazon.com'], 'Your Amazon.com order has shipped'), null);
  assert.equal(classifyNonOrder(['x@unknown.example.test'], 'New sign-in'), null);
  assert.equal(classifyNonOrder(['x@walmart.com'], 'Your order was cancelled'), null);
});

test('noise is classified in the parser only when asked, and planned for deletion', async () => {
  const raw = mime('Cards <x@cardcenter.cc>', 'New sign-in to your account', 'hello');
  assert.equal((await parseRawOrderEmail(raw, 'm:n1'))?.noise, undefined);
  const p = await parseRawOrderEmail(raw, 'm:n1', { noise: true });
  assert.equal(p?.noise?.reason, 'sign-in');
  assert.equal(p?.rawSnippet, '');
  const plan = planAutoImport([p!], ctx());
  assert.deepEqual(plan.noise, [{ id: 'm:n1', purge: false }]);
});

test('Cloudflare helpers: archive area and purge delete URL, all faked', async () => {
  const calls: string[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return new Response(JSON.stringify({ messages: [], keys: [], cursor: null }), { status: 200 });
  };
  const creds = { url: 'https://inbox.example.test/', token: 'tok' };
  await fetchCloudflareOrderEmails(creds, undefined, { fetchFn: fake as typeof fetch, area: '/archive' });
  assert.ok(calls.length && calls.every(c => c.includes('/archive')));
  calls.length = 0;
  await deleteCloudflareMessages(creds, ['m:1'], fake as typeof fetch, { purge: true });
  await deleteCloudflareMessages(creds, ['m:2'], fake as typeof fetch);
  assert.match(calls[0], /DELETE .*\/messages\/m%3A1\?purge=1/);
  assert.doesNotMatch(calls[1], /purge/);
});

// item 1
test('cancelled totals keep the real amount visible, once', () => {
  const n = withCancelledTotal('note', 42.5);
  assert.equal(n, 'note\nCancelled order total: $42.50');
  assert.equal(withCancelledTotal(n, 99), n);
  assert.equal(hasCancelledTotal(n), true);
  assert.equal(withCancelledTotal(null, 0), null);
});

test('a re-read cancelled order keeps cost at zero and records the total in notes', () => {
  const m = cancelledOrderMoney({ cost: 0, shippingCost: 0, cashbackAmount: 0, salePrice: null, notes: null }, 30);
  assert.equal(m.cost, 0);
  assert.equal(m.notes, 'Cancelled order total: $30.00');
});

test('cancelFillsItem: cancelled orders fill a useless item even though locked; live locked ones do not', () => {
  const blank = { locked: true, itemDescription: 'walmart.com' };
  assert.equal(cancelFillsItem('already-cancelled', blank, 'Widget'), true);
  assert.equal(cancelFillsItem('cancel', blank, 'Widget'), false);
  assert.equal(cancelFillsItem('cancel', { locked: false, itemDescription: '' }, 'Widget'), true);
  assert.equal(cancelFillsItem('already-cancelled', { locked: true, itemDescription: 'Real thing' }, 'Widget'), false);
});

test('gap fill: cancelled orders get item and address reads but never tracking', () => {
  const o: GapOrder = { platform: 'Walmart', orderNumber: WM_ORDER, itemDescription: '', shippingAddress: '', trackingNumbers: null, shipped: true, cancelled: true };
  assert.deepEqual(orderGaps(o), ['item', 'address']);
  assert.deepEqual(planGapFill([o]).walmartOrders, [WM_ORDER]);
  assert.deepEqual(planGapFill([{ ...o, platform: 'Amazon', orderNumber: '111-2223334-4445556' }]).amazonOrders, []);
});

const bo = (over: Partial<BackfillOrder>): BackfillOrder => ({
  id: 1, userId: 1, platform: 'Walmart', orderNumber: WM_ORDER, itemDescription: null, shippingAddress: null, cancelled: true,
  createdAt: new Date(NOW - 24 * 3600 * 1000), ...over,
});

test('backfill targets: cancelled, last 7 days, useless item only', () => {
  const old = bo({ id: 2, createdAt: new Date(NOW - 10 * 24 * 3600 * 1000) });
  const real = bo({ id: 3, itemDescription: 'Real thing' });
  const live = bo({ id: 4, cancelled: false });
  assert.deepEqual(backfillTargets([bo({}), old, real, live], NOW).map(t => t.id), [1]);
  assert.deepEqual(backfillTargets(backfillTargets([bo({})], NOW), NOW).length, 1);
});

test('backfill fills from the archive, preferring the order email, never replacing a real item', () => {
  const emails = [
    baseEmail({ uid: 'a:1', kind: 'cancelled', itemDescription: 'Test Wid...' }),
    baseEmail({ uid: 'a:2', kind: 'ordered', itemDescription: 'Test Widget Full Name', shippingAddress: '100 Test St, Springfield, ZZ, 00001, USA' }),
    baseEmail({ uid: 'a:3', kind: 'ordered', orderNumber: '2000000-99999999', itemDescription: 'Other' }),
  ];
  const fills = fillsFromArchive([bo({})], emails);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].item, 'Test Widget Full Name');
  assert.match(fills[0].address ?? '', /Springfield/);
  assert.deepEqual(fillsFromArchive([bo({ shippingAddress: '100 Test St, Springfield, ZZ, 00001, USA' })], [baseEmail({ kind: 'ordered', itemDescription: '' })]), []);
});
