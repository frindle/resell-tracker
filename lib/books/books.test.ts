import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCents } from './money.ts';
import { postEntry, reverseEntry, UnbalancedEntryError, AlreadyReversedError } from './ledger.ts';
import { sniffUpload, safeServeHeaders, uploadProblem, MAX_UPLOAD_BYTES } from '../uploadSniff.ts';
import { exclusive } from './exclusive.ts';
import { MemoryStore } from './memoryStore.ts';
import { hashEntry } from './desired.ts';
import { reconcileOrders, reconcileOpening } from './reconcile.ts';
import { type OrderForBooks, desiredOrderEntries, returnShares } from './orderPostings.ts';
import { EMPTY_OPENING } from './opening.ts';
import { type CostForBooks, reconcileCosts } from './costs.ts';
import { desiredTallyEntry, tallyNotComputed, syncTally, type TallyRow, type TallyRows } from './tally.ts';
import { parityCheck } from './parity.ts';
import { trialBalance } from './reports.ts';

const U = 1;
const GO = '2027-01-01';
const T1 = new Date('2027-02-11T20:00:00Z'); // LA day 2027-02-11
const T2 = new Date('2027-02-20T20:00:00Z'); // LA day 2027-02-20

const d = (day: string) => new Date(`${day}T00:00:00Z`);
const mk = (o: Partial<OrderForBooks> & { id: number }): OrderForBooks => ({
  platform: 'Amazon', orderDate: d('2027-02-10'), cost: 100, shippingCost: 0, insuranceCost: 0, returnedCost: 0,
  salePrice: null, buyerId: null, cardId: null, cashbackAmount: 0, portalCashback: null, amexOfferDollars: null,
  bgPaidAmount: null, bfmrStatus: null, lost: false, cancelled: false, ignoredByRule: false, giftCards: [], returns: [], ...o,
});

const rec = (s: MemoryStore, orders: OrderForBooks[], now: Date) => reconcileOrders(s, U, orders, { goLive: GO, now });
const live = (s: MemoryStore) => s.entries.filter(e => e.source !== 'reversal' && !e.reversedAt);

test('toCents: half-cent edges and negatives', () => {
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0.005), 1);
  assert.equal(toCents(-0.005), -1);
  assert.equal(toCents(2.675), 268);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(-19.99), -1999);
  assert.equal(toCents(0), 0);
  assert.equal(toCents(0.004), 0);
});

test('postEntry rejects unbalanced and non-integer entries', async () => {
  const s = new MemoryStore();
  const base = { date: '2027-02-01', memo: 'x', source: 'manual' as const, sourceKey: 'm:1', contentHash: 'h' };
  await assert.rejects(postEntry(s, U, { ...base, lines: [{ account: 'inventory_goods', amountCents: 100 }, { account: 'card_unassigned', amountCents: -99 }] }), UnbalancedEntryError);
  await assert.rejects(postEntry(s, U, { ...base, lines: [{ account: 'inventory_goods', amountCents: 10.5 }, { account: 'card_unassigned', amountCents: -10.5 }] }), UnbalancedEntryError);
  assert.equal(s.entries.length, 0);
  await postEntry(s, U, { ...base, lines: [{ account: 'inventory_goods', amountCents: 100 }, { account: 'card_unassigned', amountCents: -100 }] });
  assert.equal(s.entries.length, 1);
});

test('new order posts a purchase; cashback edit re-posts; second run is a no-op', async () => {
  const s = new MemoryStore();
  let o = mk({ id: 1, cost: 100, shippingCost: 5, cardId: 7 });
  const r1 = await rec(s, [o], T1);
  assert.equal(r1.posted, 1);
  assert.equal(s.balance(U, 'inventory_goods'), 10500);
  assert.equal(s.balance(U, 'card:7'), -10500);
  const r2 = await rec(s, [o], T1);
  assert.deepEqual([r2.posted, r2.reversed], [0, 0]);

  o = mk({ id: 1, cost: 100, shippingCost: 5, cardId: 7, cashbackAmount: 5 });
  await rec(s, [o], T1);
  assert.equal(s.balance(U, 'cashback_card_recv'), 500);
  assert.equal(s.balance(U, 'inventory_goods'), 10000);
  o = mk({ id: 1, cost: 100, shippingCost: 5, cardId: 7, cashbackAmount: 8 });
  const r3 = await rec(s, [o], T1);
  assert.deepEqual([r3.posted, r3.reversed], [1, 1]);
  assert.equal(s.balance(U, 'cashback_card_recv'), 800);
  assert.equal(s.balance(U, 'inventory_goods'), 9700);
  assert.equal(trialBalance(await s.ledgerLines(U)).totalCents, 0);
});

test('sold order moves cashback to COGS and relieves inventory', async () => {
  const s = new MemoryStore();
  const base = { id: 2, cost: 100, cashbackAmount: 4, buyerId: 3, cardId: 1 };
  await rec(s, [mk(base)], T1);
  await rec(s, [mk({ ...base, salePrice: 130 })], T2);
  assert.equal(s.balance(U, 'inventory_goods'), 0);
  assert.equal(s.balance(U, 'sales_resell'), -13000);
  assert.equal(s.balance(U, 'cogs_goods'), 9600);
  assert.equal(s.balance(U, 'buyer:3'), 13000);
  const sale = live(s).find(e => e.sourceKey === 'order:2:sale')!;
  assert.equal(sale.date, '2027-02-20');
});

test('paid with shortfall goes to returns and allowances', async () => {
  const s = new MemoryStore();
  const o = mk({ id: 3, salePrice: 100, bgPaidAmount: 90, salePriceSynced: true, buyerId: 9 });
  await rec(s, [o], T1);
  assert.equal(s.balance(U, 'undeposited_payouts'), 9000);
  assert.equal(s.balance(U, 'returns_allowances'), 1000);
  assert.equal(s.balance(U, 'buyer:9'), 10000 - 9000 - 1000);
  // overpayment goes to other income
  const o2 = mk({ id: 4, salePrice: 100, bgPaidAmount: 105, salePriceSynced: true, buyerId: 9 });
  await rec(s, [o2], T1);
  assert.equal(s.balance(U, 'other_income'), -500);
});

test('partial return refunded at a different amount', async () => {
  const s = new MemoryStore();
  const o = mk({
    id: 5, cost: 200, salePrice: 180, returnedCost: 100, buyerId: 2, cardId: 4,
    returns: [{ id: 50, status: 'refunded', quantity: 1, refundAmount: 90 }],
  });
  await rec(s, [o], T1);
  const e = live(s).find(x => x.sourceKey === 'order:5:return:50')!;
  assert.equal(e.lines.reduce((a, l) => a + l.amountCents, 0), 0);
  assert.equal(s.balance(U, 'card:4'), -20000 + 9000);
  assert.equal(s.balance(U, 'exp_other'), 1000); // 100.00 basis - 90.00 refund, tagged known
  assert.equal(s.balance(U, 'cogs_goods'), 20000 - 10000);
});

test('lost order writes off remaining inventory', async () => {
  const s = new MemoryStore();
  const o = mk({ id: 6, cost: 50, cashbackAmount: 5, lost: true });
  await rec(s, [o], T1);
  assert.equal(s.balance(U, 'inventory_loss'), 4500);
  assert.equal(s.balance(U, 'inventory_goods'), 0);
});

test('cancelled after sale reverses everything', async () => {
  const s = new MemoryStore();
  const o = mk({ id: 7, cost: 100, salePrice: 150, bgPaidAmount: 150, buyerId: 1, cardId: 1 });
  await rec(s, [o], T1);
  assert.ok(live(s).length >= 3);
  const r = await rec(s, [mk({ ...o, cancelled: true })], T2);
  assert.equal(live(s).length, 0);
  assert.ok(r.reversed >= 3);
  assert.equal(trialBalance(await s.ledgerLines(U)).rows.length, 0);
  assert.deepEqual(desiredOrderEntries(mk({ id: 8, cancelled: true }), { goLive: GO, now: T1, events: new Map() }), []);
});

test('a posting in a locked month is re-dated to the first open month', async () => {
  const s = new MemoryStore();
  s.lock(U, '2027-02');
  await rec(s, [mk({ id: 9, cost: 40 })], T1);
  const e = live(s)[0];
  assert.equal(e.date, '2027-03-01');
  assert.match(e.memo, /dated 2027-02-10/);
  // idempotent even though the entry date differs from the desired date
  const r = await rec(s, [mk({ id: 9, cost: 40 })], T1);
  assert.deepEqual([r.posted, r.reversed], [0, 0]);
});

test('opening balances with mixed pre-go-live orders and a later sale', async () => {
  const s = new MemoryStore();
  const bank = s.addAccount(U, { code: '1000', name: 'Checking', type: 'asset', business: 'shared' });
  const unsold = mk({ id: 10, orderDate: d('2026-12-10'), cost: 200, cashbackAmount: 10, buyerId: 5, cardId: 2 });
  const soldUnpaid = mk({ id: 11, orderDate: d('2026-12-11'), cost: 100, salePrice: 150, buyerId: 5 });
  const paid = mk({ id: 12, orderDate: d('2026-12-12'), cost: 100, salePrice: 150, bgPaidAmount: 150, buyerId: 5 });
  const orders = [unsold, soldUnpaid, paid];
  const input = { ...EMPTY_OPENING, banks: [{ accountId: bank.id, cents: 500000 }], cards: [{ cardId: 2, cents: 10000 }] };
  const NOW0 = new Date('2026-12-31T20:00:00Z');
  const o1 = await reconcileOpening(s, U, orders, input, { goLive: GO, now: NOW0 });
  assert.equal(o1.errors.length, 0);
  assert.equal(s.balance(U, 'inventory_goods'), 19000);
  assert.equal(s.balance(U, 'buyer:5'), 15000);
  assert.equal(s.balance(U, 'opening_balance_equity'), -(500000 + 19000 + 15000 - 10000));
  await rec(s, orders, NOW0); // nothing post-go-live to post
  assert.equal(live(s).length, 1);
  // re-running opening replaces via reversal
  const o2 = await reconcileOpening(s, U, orders, { ...input, undepositedCents: 2500 }, { goLive: GO, now: NOW0 });
  assert.deepEqual([o2.posted, o2.reversed], [1, 1]);
  assert.equal(live(s).length, 1);
  assert.equal(s.balance(U, 'undeposited_payouts'), 2500);
  // later: the unsold order sells after go-live
  const later = [mk({ ...unsold, salePrice: 250 }), soldUnpaid, paid];
  await rec(s, later, new Date('2027-03-05T20:00:00Z'));
  assert.equal(s.balance(U, 'inventory_goods'), 0);
  assert.equal(s.balance(U, 'cogs_goods'), 19000);
  assert.equal(s.balance(U, 'sales_resell'), -25000);
  // sold-unpaid order is paid later: clears its receivable
  const paidLater = [later[0], mk({ ...soldUnpaid, bgPaidAmount: 150 }), paid];
  await rec(s, paidLater, new Date('2027-03-06T20:00:00Z'));
  assert.equal(s.balance(U, 'buyer:5'), 25000); // only the post-go-live sale is still unpaid
  assert.equal(trialBalance(await s.ledgerLines(U)).totalCents, 0);
});

test('cost entry at 60% business sends 40% to owner draws; void reverses', async () => {
  const s = new MemoryStore();
  const bank = s.addAccount(U, { code: '1000', name: 'Checking', type: 'asset', business: 'shared' });
  const c: CostForBooks = {
    id: 1, business: 'resell', date: '2027-02-02', amountCents: 10000, category: 'supplies', vendor: 'Example',
    purpose: 'Boxes', businessPct: 60, paidFromAccountId: bank.id, voidedAt: null,
  };
  await reconcileCosts(s, U, [c], T1);
  assert.equal(s.balance(U, 'exp_supplies_postage'), 6000);
  assert.equal(s.balance(U, 'owner_draws'), 4000);
  assert.equal(s.balance(U, 'owner_draws') + s.balance(U, 'exp_supplies_postage'), 10000);
  const r = await reconcileCosts(s, U, [c], T1);
  assert.deepEqual([r.posted, r.reversed], [0, 0]);
  await reconcileCosts(s, U, [{ ...c, voidedAt: T2 }], T2);
  assert.equal(live(s).length, 0);
  assert.equal(s.balance(U, 'owner_draws'), 0);
});

const fx = JSON.parse(readFileSync(new URL('./fixtures/tally.json', import.meta.url), 'utf8'));
const tallyFetch = (data: typeof fx) => (async (url: string | URL | Request) => {
  const u = new URL(String(url));
  const body = u.pathname.endsWith('/months') ? data.index : data.months[u.searchParams.get('month')!];
  return { json: async () => body } as Response;
}) as typeof fetch;
const memRows = (): TallyRows & { rows: Map<string, TallyRow & { payload: string }> } => {
  const rows = new Map<string, TallyRow & { payload: string }>();
  return {
    rows,
    get: async (_u, m) => rows.get(m) ?? null,
    save: async (_u, r) => { rows.set(r.month, r); },
  };
};

test('tally consumer posts once, re-posts on change, skips non-final and pre-go-live', async () => {
  const s = new MemoryStore();
  const rows = memRows();
  const opts = { baseUrl: 'http://ledger.test', goLive: GO, now: T1, fetchFn: tallyFetch(fx) };
  const r1 = await syncTally(s, rows, U, opts);
  assert.ok(!('disabled' in r1));
  if ('disabled' in r1) return;
  assert.equal(r1.posted, 1);
  assert.equal(r1.skippedNonFinal, 1);
  assert.deepEqual([...rows.rows.keys()], ['2027-01']);
  assert.equal(s.balance(U, 'darkbloom_earnings'), -210000);
  assert.equal(s.balance(U, 'darkbloom_balance'), 210700);
  assert.equal(s.balance(U, 'darkbloom_equipment'), 0);   // capitalized entries do not post
  assert.equal(s.balance(U, 'other_income'), -700);        // income posts once, via other_income_cents
  assert.equal(s.balance(U, 'owner_draws'), 0);
  assert.equal(s.balance(U, 'exp_utilities'), 7500);       // 4500 power column + 3000 internet; the metered_power entry is not posted again
  const r2 = await syncTally(s, rows, U, opts);
  assert.ok(!('disabled' in r2));
  if (!('disabled' in r2)) assert.deepEqual([r2.posted, r2.reversed, r2.unchanged], [0, 0, 1]);
  // the month changes: hash differs and earnings differ
  const changed = structuredClone(fx);
  changed.index.months[1].hash = 'h-2027-01-v2';
  changed.months['2027-01'].hash = 'h-2027-01-v2';
  changed.months['2027-01'].machines[1].earnings_cents = 95000;
  const r3 = await syncTally(s, rows, U, { ...opts, fetchFn: tallyFetch(changed) });
  if (!('disabled' in r3)) assert.deepEqual([r3.posted, r3.reversed], [1, 1]);
  assert.equal(s.balance(U, 'darkbloom_earnings'), -215000);
  assert.equal(live(s).length, 1);
  // disabled when no URL
  assert.deepEqual(await syncTally(s, rows, U, { ...opts, baseUrl: undefined }), { disabled: true });
  assert.equal(desiredTallyEntry(fx.months['2027-02']).length, 1); // pure fn ignores finality; syncTally gates it
  assert.equal(hashEntry(desiredTallyEntry(fx.months['2027-01'])[0]).length, 64);
});

test('parity over fixtures equals calcStats for settled orders; unsold is timing', async () => {
  const s = new MemoryStore();
  const orders = [
    mk({ id: 21, cost: 100, shippingCost: 6, cashbackAmount: 3.33, portalCashback: 1.005, salePrice: 140, buyerId: 1, cardId: 1 }),
    mk({ id: 22, cost: 100, salePrice: 100, bgPaidAmount: 90, salePriceSynced: true, buyerId: 1 }),
    mk({ id: 23, cost: 200, salePrice: 180, returnedCost: 90, returns: [{ id: 1, status: 'refunded', quantity: 1, refundAmount: 90 }], buyerId: 1 }),
    mk({ id: 24, cost: 50, lost: true }),
    mk({ id: 25, cost: 70 }),
    mk({ id: 26, cost: 10, cancelled: true }),
  ];
  await rec(s, orders, T1);
  const rows = parityCheck(orders, await s.ledgerLines(U), GO, T1);
  const by = new Map(rows.map(r => [r.orderId, r]));
  for (const id of [21, 22, 23, 24]) assert.equal(by.get(id)!.status, 'match', `order ${id}: ${JSON.stringify(by.get(id))}`);
  assert.equal(by.get(25)!.status, 'timing');
  assert.equal(by.has(26), false);
  assert.equal(by.get(22)!.knownCents, 1000);
});

test('two overlapping runs on a changed order: one reversal, one new entry', async () => {
  const s = new MemoryStore();
  const o1 = mk({ id: 31, cost: 100, cardId: 7 });
  await rec(s, [o1], T1);
  const o2 = mk({ id: 31, cost: 120, cardId: 7 });
  const [a, b] = await Promise.all([rec(s, [o2], T1), rec(s, [o2], T1)]);
  assert.equal(a.errors.length + b.errors.length, 0);
  assert.equal(a.reversed + b.reversed, 1);
  assert.equal(a.posted + b.posted, 1);
  assert.equal(s.entries.filter(e => e.source === 'reversal').length, 1);
  assert.equal(live(s).length, 1);
  assert.equal(s.balance(U, 'inventory_goods'), 12000);
  assert.equal(trialBalance(await s.ledgerLines(U)).totalCents, 0);
});

test('reverseEntry aborts the transaction when the entry was already reversed', async () => {
  const s = new MemoryStore();
  await rec(s, [mk({ id: 32, cost: 10 })], T1);
  const e = live(s)[0];
  await s.markReversed(e.id, T1);                               // another run got there first
  await assert.rejects(reverseEntry(s, U, e, T2), AlreadyReversedError);
  assert.equal(s.entries.filter(x => x.source === 'reversal').length, 0);
});

test('exclusive() lock lives on globalThis so separate bundles share it', async () => {
  const order: string[] = [];
  const a = exclusive(1, async () => { order.push('a1'); await new Promise(r => setTimeout(r, 20)); order.push('a2'); });
  const b = exclusive(1, async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
  const sym = Symbol.for('resell-tracker.books.exclusive');
  assert.ok((globalThis as unknown as Record<symbol, unknown>)[sym] instanceof Map);
});

const noon = (day: string) => new Date(`${day}T20:00:00Z`);
const T3 = new Date('2027-04-15T20:00:00Z'); // LA day 2027-04-15, three months after go-live

test('enabling after go-live: pre-go-live sold orders post no sale, opening carries them as receivable', async () => {
  const s = new MemoryStore();
  const o = mk({ id: 40, orderDate: d('2026-11-20'), cost: 100, salePrice: 130, buyerId: 9 });
  const r = await rec(s, [o], T3);
  assert.equal(r.errors.length, 0);
  assert.equal(live(s).filter(e => e.sourceKey.startsWith('order:40:')).length, 0);
  assert.equal(s.inferredEvents.has('40|sold'), true);
  const op = await reconcileOpening(s, U, [o], EMPTY_OPENING, { goLive: GO, now: T3 });
  assert.equal(op.receivableCents, 13000);
  assert.equal(op.inventoryCents, 0);
  assert.equal((await rec(s, [o], T3)).posted, 0);
});

test('enabling after go-live: a sale with a real date posts on that date', async () => {
  const s = new MemoryStore();
  const o = mk({
    id: 41, platform: 'CardCenter', orderDate: d('2027-02-01'), cost: 100, salePrice: 100, buyerId: 9,
    giftCards: [{ ccSubmittedAt: noon('2027-02-20'), ccPaymentStatus: 'Completed', ccPaymentDueAt: noon('2027-03-05') }],
  });
  await rec(s, [o], T3);
  const sale = live(s).find(e => e.sourceKey === 'order:41:sale');
  assert.equal(sale?.date, '2027-02-20');
  assert.equal(live(s).find(e => e.sourceKey === 'order:41:paid')?.date, '2027-03-05');
});

test('a refund with refundedAt stamps that day, not the enable day', async () => {
  const s = new MemoryStore();
  const o = mk({ id: 42, cost: 100, cardId: 7, returnedCost: 40, returns: [{ id: 1, status: 'refunded', quantity: 1, refundAmount: 40, refundedAt: noon('2027-02-15') }] });
  await rec(s, [o], T3);
  assert.equal(live(s).find(e => e.sourceKey === 'order:42:return:1')?.date, '2027-02-15');
});

test('tally: real kinds, receipts post only deductible expenses, null columns are reported not computed', () => {
  const m = fx.months['2027-01'];
  const e = desiredTallyEntry(m)[0];
  const sum = (acct: string) => e.lines.filter((l: { account: string | number }) => l.account === acct).reduce((x: number, l: { amountCents: number }) => x + l.amountCents, 0);
  assert.equal(sum('other_income'), -700);
  assert.equal(sum('darkbloom_equipment'), 0);
  assert.equal(sum('owner_draws'), 0);
  assert.equal(e.lines.reduce((x: number, l: { amountCents: number }) => x + l.amountCents, 0), 0);
  const nc = tallyNotComputed(m);
  assert.ok(nc.some(x => x.machine === 'm4' && x.column === 'lease_cents'));
  assert.ok(!nc.some(x => x.column === 'earnings_cents'));
});

test('return shares follow returnedCostFor for mixed statuses and sum to returnedCost', () => {
  const returns = [
    { id: 1, status: 'refunded', quantity: 1, refundAmount: 90 },
    { id: 2, status: 'in_transit', quantity: 2, refundAmount: null },
    { id: 3, status: 'rejected', quantity: 1, refundAmount: null },
  ];
  const perUnit = 30; // 4 units, 90 refunded for one, so 30 each for the two in flight (cost 120 total)
  // returnedCostFor (lib/orderReturns.ts, not importable here: it pulls in prisma) gives 90 + 2*30 = 150
  const returnedCost = 90 + perUnit * 2;
  const shares = returnShares(mk({ id: 60, cost: 120, returnedCost, returns }));
  assert.equal(shares.get(1), 9000);
  assert.equal(shares.get(2), 6000);
  assert.equal(shares.has(3), false);
  assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 15000);
});

test('uploads: type comes from magic bytes, not the client; unsafe files are refused', () => {
  const b = (...x: number[]) => Uint8Array.from(x);
  const pad = (a: Uint8Array, n = 16) => { const o = new Uint8Array(Math.max(n, a.length)); o.set(a); return o; };
  const ascii = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
  assert.equal(sniffUpload(ascii('%PDF-1.7 x'))?.mime, 'application/pdf');
  assert.equal(sniffUpload(pad(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))?.mime, 'image/png');
  assert.equal(sniffUpload(pad(b(0xff, 0xd8, 0xff, 0xe0)))?.mime, 'image/jpeg');
  assert.equal(sniffUpload(ascii('RIFF\0\0\0\0WEBPVP8 '))?.mime, 'image/webp');
  assert.equal(sniffUpload(ascii('\0\0\0\x18ftypheic\0\0\0\0'))?.mime, 'image/heic');
  assert.equal(sniffUpload(ascii('<html><script>alert(1)</script>')), null);       // html claiming to be an image
  assert.equal(sniffUpload(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.ok(uploadProblem(ascii('<html>')));
  assert.equal(uploadProblem(ascii('%PDF-1.4')), null);
  assert.ok(uploadProblem(new Uint8Array(MAX_UPLOAD_BYTES + 1)));
  const h = safeServeHeaders(null, 'a"b.html');
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.match(h['Content-Disposition'], /^attachment;/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Content-Security-Policy'], 'sandbox');
  assert.match(safeServeHeaders({ mime: 'image/png', ext: '.png' }, 'x.png')['Content-Disposition'], /^inline;/);
});
