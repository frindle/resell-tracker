import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredTallyEntry, type TallyMonth, type TallyMachine } from './books/tally.ts';
import { CHART_BY_KEY } from './books/chart.ts';
import { parseInvoice, invoiceMoney, withBloomMonthly } from './bloomInvoice.ts';

// One Bloom number: the books' double-entry tally and the analytics/side-hustle invoice must agree to the cent for
// every month. Both are built here from the same synthetic ledger month (all amounts are made up).
type Month = { month: string; payout: number; fees: number; other: number; power: number | null; lease: number | null; dep: number; entries: number; machines?: number };

const MONTHS: Month[] = [
  { month: '2030-01', payout: 21_000, fees: 1_000, other: 0, power: 400, lease: 3_650, dep: 7_000, entries: 0 },      // sandbox fee, lease, depreciation (ignored)
  { month: '2030-02', payout: 1_625, fees: 0, other: 0, power: 0, lease: 0, dep: 0, entries: 0 },                    // only inference pay, nothing else
  { month: '2030-03', payout: 90_001, fees: 4_445, other: 501, power: null, lease: null, dep: 3_978, entries: 1_299 }, // power and lease not computed
  { month: '2030-04', payout: 0, fees: 0, other: 0, power: 19, lease: 3_650, dep: 0, entries: 0 },                    // costs but no pay: a negative month
  { month: '2030-05', payout: 33_333, fees: 777, other: 0, power: 123, lease: 3_650, dep: 100, entries: 0, machines: 2 }, // two machines
];

function machines(m: Month): TallyMachine[] {
  const split = (v: number | null, i: number, n: number) => (v == null ? null : i === 0 ? v - Math.floor(v / n) * (n - 1) : Math.floor(v / n));
  const n = m.machines ?? 1;
  return Array.from({ length: n }, (_, i) => ({
    machine_id: `m${i}`, shared: false,
    earnings_cents: split(m.payout, i, n), fees_cents: split(m.fees, i, n), other_income_cents: i === 0 ? m.other : 0,
    power_cost_cents: split(m.power, i, n), depreciation_cents: split(m.dep, i, n), lease_cents: split(m.lease, i, n),
    entries_deductible_cents: 0,
    entries: i === 0 && m.entries ? [{ kind: 'cost', category: 'software', amount_cents: m.entries, deductible_cents: m.entries, effect: 'expense', business_pct: 100 }] : [],
  }));
}

const tally = (m: Month): TallyMonth => ({ month: m.month, final: true, hash: `t-${m.month}`, machines: machines(m) });

// The invoice as the ledger now sends it: gross = payout + fees, no depreciation cost; an unknown cost is null.
const invoiceJson = (m: Month, withDepreciation = false) => ({
  month: m.month, invoice_id: `BL-${m.month}`, issue_date: '2030-12-01', currency: 'USD', final: true, hash: `i-${m.month}`,
  gross_cents: m.payout + m.fees, fees_cents: m.fees, other_income_cents: m.other,
  lines: [{ key: 'inference', label: 'Inference', amount_cents: m.payout + m.fees, count: 1, tokens: 1 }],
  costs: [
    { key: 'power_cost', label: 'Metered power', amount_cents: m.power }, ...(withDepreciation ? [{ key: 'depreciation', label: 'Depreciation', amount_cents: m.dep }] : []),
    { key: 'lease', label: 'Equipment lease', amount_cents: m.lease }, { key: 'entries_deductible', label: 'Purchases', amount_cents: m.entries },
  ],
  costs_unknown: [], net_cents: 123456, usage: {}, machine_count: 1,
});

/** Net income of the darkbloom journal entry: income accounts (credits) minus expense accounts (debits). */
function booksNet(t: TallyMonth): number {
  let net = 0;
  for (const e of desiredTallyEntry(t)) {
    for (const l of e.lines) {
      const type = CHART_BY_KEY.get(String(l.account))?.type;
      if (type === 'income') net += -l.amountCents;
      else if (type === 'expense') net -= l.amountCents;
    }
  }
  return net;
}

test('books net equals the invoice net, to the cent, for every month', () => {
  for (const m of MONTHS) {
    const inv = parseInvoice(invoiceJson(m), m.month);
    assert.ok('ok' in inv, m.month);
    const want = m.payout + m.other - (m.power ?? 0) - (m.lease ?? 0) - m.entries; // gross - fees - power - lease, the fee taken off once
    assert.equal(inv.ok.netCents, want, `${m.month} invoice`);
    assert.equal(booksNet(tally(m)), want, `${m.month} books`);
    assert.equal(booksNet(tally(m)), inv.ok.netCents, `${m.month} reconcile`);
  }
});

test('books income is the invoice gross and the books fee line is the invoice fees', () => {
  for (const m of MONTHS) {
    const lines = desiredTallyEntry(tally(m)).flatMap(e => e.lines);
    const sum = (a: string) => lines.filter(l => String(l.account) === a).reduce((s, l) => s + l.amountCents, 0);
    const inv = parseInvoice(invoiceJson(m), m.month);
    assert.ok('ok' in inv);
    assert.equal(-sum('darkbloom_earnings'), inv.ok.grossCents, m.month);
    assert.equal(sum('exp_commissions'), inv.ok.feesCents, m.month);
    assert.equal(sum('exp_depreciation') + sum('accum_depreciation'), 0, 'no depreciation is posted');
  }
});

test('an invoice from a ledger that still sends depreciation does not carry it into the net', () => {
  const m = MONTHS[0];
  const inv = parseInvoice(invoiceJson(m, true), m.month);
  assert.ok('ok' in inv);
  assert.equal(inv.ok.netCents, m.payout - (m.power ?? 0) - (m.lease ?? 0));
  assert.ok(!inv.ok.costs.some(c => c.key === 'depreciation'));
});

test('the analytics monthly Bloom net is the books net for every month', () => {
  const stored = MONTHS.map(m => { const p = parseInvoice(invoiceJson(m), m.month); assert.ok('ok' in p); return invoiceMoney(p.ok); });
  const rows = withBloomMonthly([], stored, month => ({ month, revenue: 0, cost: 0, cashback: 0, interest: 0, profit: 0, miles: 0, count: 0 }));
  assert.equal(rows.length, MONTHS.length);
  for (const r of rows) {
    const m = MONTHS.find(x => x.month === r.month)!;
    assert.equal(Math.round(r.bloomNet * 100), booksNet(tally(m)), r.month);
  }
});
