import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, netCents, syncInvoices, bloomInRange, withBloomMonthly, type InvoiceRows, type StoredInvoice, type InvoiceMoney } from './bloomInvoice.ts';

// All figures are synthetic.
function raw(month: string, over: Record<string, unknown> = {}) {
  return {
    month, invoice_id: `BL-${month}`, issue_date: '2030-02-01', currency: 'USD', final: true, hash: `h-${month}-1`,
    gross_cents: 10000, other_income_cents: 0, fees_cents: null, fees_note: 'none reported',
    lines: [{ key: 'inference', label: 'Inference', amount_cents: 7000, count: 5, tokens: 900 }, { key: 'sandbox', label: 'Sandbox', amount_cents: 3000, count: 2, tokens: 0 }],
    costs: [{ key: 'power', label: 'Power', amount_cents: 1500 }, { key: 'lease', label: 'Lease', amount_cents: null }],
    costs_unknown: ['lease'], net_cents: 99999, usage: { tokens: 900, jobs: 7, inference_minutes: 30, sandbox_minutes: 10, vcpu_seconds: null }, machine_count: 1,
    ...over,
  };
}

function memRows() {
  const db = new Map<string, StoredInvoice>();
  const writes: string[] = [];
  const rows: InvoiceRows = {
    async getHash(u, m) { return db.get(`${u}|${m}`)?.hash ?? null; },
    async upsert(u, r) { db.set(`${u}|${r.month}`, r); writes.push(r.month); },
  };
  return { db, rows, writes };
}

function ledger(months: { month: string; final: boolean; hash: string }[], bodies: Record<string, unknown>) {
  const f = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/v1/invoice/months') return new Response(JSON.stringify({ months }));
    if (u.pathname === '/v1/invoice/monthly') return new Response(JSON.stringify(bodies[u.searchParams.get('month')!]));
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return f;
}

test('net is recomputed, ignoring the ledger figure, and unknown costs count as zero', () => {
  const r = parseInvoice(raw('2030-01'));
  assert.ok('ok' in r);
  assert.equal(r.ok.netCents, 10000 - 1500);
  assert.equal(netCents(10000, 200, 300, [1500, null]), 8400);
});

test('parse rejects bad month, mismatched month, missing hash and lines', () => {
  assert.ok('error' in parseInvoice(raw('2030-13')));
  assert.ok('error' in parseInvoice(raw('2030-01'), '2030-02'));
  assert.ok('error' in parseInvoice(raw('2030-01', { hash: '' })));
  assert.ok('error' in parseInvoice(raw('2030-01', { lines: undefined })));
  assert.ok('error' in parseInvoice(raw('2030-01', { gross_cents: -1 })));
});

test('sync creates, then is idempotent, then updates on a changed hash without duplicating', async () => {
  const { db, rows, writes } = memRows();
  const idx = [{ month: '2030-01', final: true, hash: 'h-2030-01-1' }];
  const bodies = { '2030-01': raw('2030-01') };
  const a = await syncInvoices(rows, 1, { baseUrl: 'http://ledger.test/', fetchFn: ledger(idx, bodies) });
  assert.deepEqual(a, { checked: 1, created: 1, updated: 0, unchanged: 0, skippedNonFinal: 0, errors: [] });
  const b = await syncInvoices(rows, 1, { baseUrl: 'http://ledger.test', fetchFn: ledger(idx, bodies) });
  assert.equal('disabled' in b ? -1 : b.unchanged, 1);
  assert.equal(writes.length, 1);
  const idx2 = [{ month: '2030-01', final: true, hash: 'h-2030-01-2' }];
  const c = await syncInvoices(rows, 1, { baseUrl: 'http://ledger.test', fetchFn: ledger(idx2, { '2030-01': raw('2030-01', { hash: 'h-2030-01-2', gross_cents: 12000 }) }) });
  assert.equal('disabled' in c ? -1 : c.updated, 1);
  assert.equal(db.size, 1);
  assert.equal(db.get('1|2030-01')!.grossCents, 12000);
});

test('sync skips months that are not final, is per user, and reports errors per month', async () => {
  const { db, rows } = memRows();
  const idx = [{ month: '2030-01', final: true, hash: 'x' }, { month: '2030-02', final: false, hash: 'y' }, { month: '2030-03', final: true, hash: 'z' }];
  const f = ledger(idx, { '2030-01': raw('2030-01', { hash: 'x' }), '2030-03': { month: '2030-03' } });
  const r = await syncInvoices(rows, 7, { baseUrl: 'http://ledger.test', fetchFn: f });
  assert.ok(!('disabled' in r));
  if ('disabled' in r) return;
  assert.equal(r.created, 1); assert.equal(r.skippedNonFinal, 1); assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^2030-03/);
  assert.deepEqual([...db.keys()], ['7|2030-01']);
});

test('sync is disabled without a URL and reports an index failure', async () => {
  const { rows } = memRows();
  assert.deepEqual(await syncInvoices(rows, 1, { baseUrl: undefined }), { disabled: true });
  const bad = (async () => new Response('x', { status: 500 })) as typeof fetch;
  const r = await syncInvoices(rows, 1, { baseUrl: 'http://ledger.test', fetchFn: bad });
  assert.ok(!('disabled' in r) && r.errors.length === 1 && r.checked === 0);
});

const inv = (month: string, net: number, gross = net): InvoiceMoney => ({ month, grossCents: gross, otherIncomeCents: 0, feesCents: 0, costsCents: gross - net, netCents: net });

test('P&L range counts only whole months, with and without Bloom', () => {
  const invs = [inv('2030-01', 8500, 10000), inv('2030-02', 5000)];
  const d = (s: string) => new Date(`${s}T12:00:00`);
  const jan = bloomInRange(invs, d('2030-01-01'), d('2030-01-31'));
  assert.equal(jan.netCents, 8500); assert.equal(jan.months, 1); assert.equal(jan.costsCents, 1500);
  assert.equal(bloomInRange(invs, d('2030-01-02'), d('2030-01-31')).months, 0);
  assert.equal(bloomInRange(invs, d('2030-01-01'), d('2030-01-30')).months, 0);
  assert.equal(bloomInRange(invs, d('2030-01-01'), d('2030-02-28')).netCents, 13500);
  const none = bloomInRange([], d('2030-01-01'), d('2030-12-31'));
  assert.deepEqual(none, { grossCents: 0, otherIncomeCents: 0, feesCents: 0, costsCents: 0, netCents: 0, months: 0 });
});

test('monthly rows: combined equals profit without Bloom, adds Bloom with it, and Bloom-only months appear', () => {
  const blank = (month: string) => ({ month, profit: 0, revenue: 0 });
  const rows = [{ month: '2030-01', profit: 40.5, revenue: 100 }, { month: '2030-02', profit: -2, revenue: 10 }];
  const without = withBloomMonthly(rows, [], blank);
  assert.deepEqual(without.map(r => r.combined), [40.5, -2]);
  assert.ok(without.every(r => r.bloomNet === 0));
  const withB = withBloomMonthly(rows, [inv('2030-01', 8500, 10000), inv('2030-03', 1234)], blank);
  assert.deepEqual(withB.map(r => r.month), ['2030-01', '2030-02', '2030-03']);
  assert.deepEqual(withB.map(r => r.combined), [125.5, -2, 12.34]);
  assert.equal(withB[0].bloomGross, 100); assert.equal(withB[0].bloomCost, 15); assert.equal(withB[0].revenue, 100);
});
