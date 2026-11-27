// P4 report tests: pure functions over ledger lines built from made-up entries (no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memoryStore.ts';
import { postEntry } from './ledger.ts';
import type { EntryInput, LedgerLineRow, LineInput } from './types.ts';
import { trialBalance } from './reports.ts';
import { balanceSheet } from './balanceSheet.ts';
import { cashFlowByMonth, cashBalance } from './cashFlow.ts';
import { inventoryOnHand, bucketOf } from './inventory.ts';
import { scheduleC } from './scheduleC.ts';
import { check1099K, receiptsByPayer, K1099_REFERENCE } from './k1099.ts';
import { toCsv } from './csv.ts';
import { decimalCents } from './money.ts';
import { toBeancount, beancountAccount } from './beancount.ts';
import { balanceSheetCsv, cashFlowCsv, inventoryCsv, k1099Csv, scheduleCCsv } from './reportExports.ts';

const U = 1;

async function fixture() {
  const s = new MemoryStore();
  const bank = s.addAccount(U, { code: '1010', name: 'Checking', type: 'asset', business: 'shared' });
  const bank2 = s.addAccount(U, { code: '1020', name: 'Savings', type: 'asset', business: 'shared' });
  let n = 0;
  const post = (date: string, memo: string, lines: LineInput[], source: EntryInput['source'] = 'manual') =>
    postEntry(s, U, { date, memo, source, sourceKey: `t:${++n}`, contentHash: `h${n}`, lines });
  await post('2026-12-31', 'Opening', [{ account: bank.id, amountCents: 100_000 }, { account: 'opening_balance_equity', amountCents: -100_000 }], 'opening');
  await post('2027-02-01', 'Buy goods', [{ account: 'inventory_goods', amountCents: 5000, orderId: 1 }, { account: 'card:7', amountCents: -5000, orderId: 1 }]);
  await post('2027-02-10', 'Buy gift cards', [{ account: 'inventory_giftcards', amountCents: 2000, orderId: 2 }, { account: 'card:7', amountCents: -2000, orderId: 2 }]);
  await post('2027-02-15', 'Pay card', [{ account: 'card:7', amountCents: 7000 }, { account: bank.id, amountCents: -7000 }]);
  await post('2027-03-01', 'Sale', [
    { account: 'buyer:5', amountCents: 9000, orderId: 1 }, { account: 'sales_resell', amountCents: -9000, orderId: 1, business: 'resell' },
    { account: 'cogs_goods', amountCents: 5000, orderId: 1, business: 'resell' }, { account: 'inventory_goods', amountCents: -5000, orderId: 1 },
  ], 'order');
  await post('2027-03-05', 'Paid', [{ account: 'undeposited_payouts', amountCents: 9000, orderId: 1 }, { account: 'buyer:5', amountCents: -9000, orderId: 1 }], 'order');
  await post('2027-03-08', 'Deposit', [{ account: bank.id, amountCents: 9000 }, { account: 'undeposited_payouts', amountCents: -9000 }]);
  await post('2027-03-12', 'Shared cost', [{ account: 'exp_utilities', amountCents: 1000, business: 'shared' }, { account: bank.id, amountCents: -1000 }], 'cost');
  await post('2027-03-15', 'Loan', [{ account: bank.id, amountCents: 50_000 }, { account: 'loan:1', amountCents: -50_000 }]);
  await post('2027-03-20', 'Transfer', [{ account: bank2.id, amountCents: 2000 }, { account: bank.id, amountCents: -2000 }]);
  await post('2027-03-31', 'Darkbloom tally', [
    { account: 'darkbloom_balance', amountCents: 3000, business: 'darkbloom' }, { account: 'darkbloom_earnings', amountCents: -3000, business: 'darkbloom' },
    { account: 'exp_depreciation', amountCents: 500, business: 'darkbloom' }, { account: 'accum_depreciation', amountCents: -500, business: 'darkbloom' },
  ], 'darkbloom');
  return { s, lines: await s.ledgerLines(U) };
}

test('balance sheet balances, rolls earnings into equity, and respects the as-of date', async () => {
  const { lines } = await fixture();
  const b = balanceSheet(lines, '2027-03-31');
  assert.equal(b.differenceCents, 0);
  assert.equal(b.totalLiabilitiesCents, 50_000); // loan; the card is paid off
  const ytd = b.equity.find(r => r.name.startsWith('Earnings, 2027'))!;
  assert.equal(ytd.cents, 9000 - 5000 - 1000 + 3000 - 500); // 5500
  assert.equal(b.totalEquityCents, 100_000 + 5500);
  const early = balanceSheet(lines, '2027-02-12');
  assert.equal(early.differenceCents, 0);
  assert.equal(early.totalAssetsCents, 100_000 + 5000 + 2000);
  assert.equal(early.liabilities[0].cents, 7000);
  assert.equal(balanceSheet(lines, '2026-12-31').totalAssetsCents, 100_000);
  // prior-year earnings split: as of next year the 2027 earnings are "prior years"
  const ny = balanceSheet(lines, '2028-01-05');
  assert.ok(ny.equity.some(r => r.name.startsWith('Earnings, prior years') && r.cents === 5500));
  assert.equal(ny.differenceCents, 0);
});

test('cash flow: transfers drop out, loan is financing, opening is separate, ending ties to the ledger cash', async () => {
  const { lines } = await fixture();
  const cf = cashFlowByMonth(lines);
  assert.deepEqual(cf.map(m => m.month), ['2026-12', '2027-02', '2027-03']);
  assert.equal(cf[0].openingCents, 100_000);
  assert.equal(cf[1].operatingCents, -7000);
  const mar = cf[2];
  assert.equal(mar.financingCents, 50_000);
  assert.equal(mar.operatingCents, 9000 - 1000);
  assert.equal(mar.netCents, 58_000);
  assert.equal(mar.beginCents, 93_000);
  assert.equal(mar.endCents, cashBalance(lines));
  assert.equal(cashBalance(lines), 100_000 - 7000 + 9000 - 1000 + 50_000);
});

test('inventory: one lot per order, tied to the accounts, aged from the order date', async () => {
  const { lines } = await fixture();
  const r = inventoryOnHand(lines, '2027-03-31', new Map([[2, '2027-01-05']]));
  assert.equal(r.lots.length, 1); // order 1 was sold, so only the gift cards remain
  assert.equal(r.lots[0].orderId, 2);
  assert.equal(r.lots[0].valueCents, 2000);
  assert.equal(r.lots[0].giftCardsCents, 2000);
  assert.equal(r.lots[0].acquired, '2027-01-05');
  assert.equal(r.lots[0].ageDays, 85);
  assert.equal(r.lots[0].bucket, '61-90');
  assert.equal(r.totalCents, r.accountBalanceCents);
  assert.equal(r.differenceCents, 0);
  const before = inventoryOnHand(lines, '2027-02-20');
  assert.equal(before.lots.length, 2);
  assert.equal(before.totalCents, 7000);
  assert.equal(before.lots.find(l => l.orderId === 1)!.ageDays, 19); // from its first debit date
  assert.equal(before.differenceCents, 0);
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 180, 181].map(bucketOf), ['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '91-180', '91-180', '181+']);
});

test('inventory: a line with no order becomes its own lot so the tie still holds', async () => {
  const s = new MemoryStore();
  await postEntry(s, U, { date: '2027-01-01', memo: 'm', source: 'manual', sourceKey: 'm', contentHash: 'h', lines: [{ account: 'inventory_goods', amountCents: 700 }, { account: 'opening_balance_equity', amountCents: -700 }] });
  const r = inventoryOnHand(await s.ledgerLines(U), '2027-01-31');
  assert.equal(r.lots[0].orderId, null);
  assert.equal(r.differenceCents, 0);
});

test('schedule C: one worksheet per business, shared costs counted on Resell and shown', async () => {
  const { lines } = await fixture();
  const r = scheduleC(lines, 2027, 'resell');
  assert.equal(r.line1Cents, 9000);
  assert.equal(r.line4Cents, 5000);
  assert.equal(r.line5Cents, 4000);
  assert.deepEqual(r.expenses, [{ line: '25', label: 'Utilities', cents: 1000 }]);
  assert.equal(r.line31Cents, 3000);
  assert.equal(r.sharedIncludedCents, -1000); // net effect on profit: a 1,000 expense
  assert.equal(r.partIII.beginInventoryCents, 0);
  assert.equal(r.partIII.endInventoryCents, 2000);
  assert.equal(r.partIII.purchasesCents, 5000 + 2000 - 0);
  const d = scheduleC(lines, 2027, 'darkbloom');
  assert.equal(d.line1Cents, 3000);
  assert.deepEqual(d.expenses.map(e => [e.line, e.cents]), [['13', 500]]);
  assert.equal(d.line31Cents, 2500);
  assert.ok(d.notes[0].includes('Not tax advice'));
  // another year is empty; the opening inventory becomes the beginning inventory
  const next = scheduleC(lines, 2028, 'resell');
  assert.equal(next.line1Cents, 0);
  assert.equal(next.partIII.beginInventoryCents, 2000);
  // the two businesses plus nothing else add up to the P&L
  assert.equal(r.line31Cents + d.line31Cents, 5500);
});

test('1099-K check: compares the form with gross receipts from the linked payers, reversals net out', async () => {
  const { s, lines } = await fixture();
  const m = receiptsByPayer(lines, 2027);
  assert.equal(m.get('buyer:5')!.grossCents, 9000);
  assert.equal(m.get('buyer:5')!.receivedCents, 9000);
  assert.equal(m.get('darkbloom')!.grossCents, 3000);
  const rows = check1099K(lines, [
    { id: 1, year: 2027, payerName: 'Pay Co', payerKeys: 'buyer:5', amountCents: 9000, transactions: 3, note: null },
    { id: 2, year: 2027, payerName: 'Big Pay', payerKeys: 'buyer:5,darkbloom', amountCents: 2_500_000, transactions: 250, note: null },
    { id: 3, year: 2027, payerName: 'Low Pay', payerKeys: 'buyer:9', amountCents: 100, transactions: null, note: null },
    { id: 4, year: 2026, payerName: 'Old', payerKeys: 'buyer:5', amountCents: 0, transactions: null, note: null },
  ]);
  assert.equal(rows[0].status, 'match');
  assert.equal(rows[0].reference.meets, false);
  assert.equal(rows[1].differenceCents, 2_500_000 - 12_000);
  assert.equal(rows[1].status, 'form_higher');
  assert.equal(rows[1].reference.meets, true);
  assert.equal(rows[2].booksGrossCents, 0);
  assert.equal(rows[2].reference.meets, null);
  assert.equal(rows[3].status, 'match'); // 2026 has no sales
  assert.deepEqual([K1099_REFERENCE.amountCents, K1099_REFERENCE.transactions], [2_000_000, 200]);
  // a reversed sale nets to zero
  await postEntry(s, U, { date: '2027-04-01', memo: 'rev', source: 'reversal', sourceKey: 'r', contentHash: 'r', lines: [
    { account: 'buyer:5', amountCents: -9000 }, { account: 'sales_resell', amountCents: 9000 }] });
  const after = check1099K(await s.ledgerLines(U), [{ id: 1, year: 2027, payerName: 'Pay Co', payerKeys: 'buyer:5', amountCents: 0, transactions: null, note: null }]);
  assert.equal(after[0].booksGrossCents, 0);
  assert.equal(after[0].status, 'match');
  // one payout that settles two payers credits each with its own part
  await postEntry(s, U, { date: '2027-05-01', memo: 'sales', source: 'manual', sourceKey: 's2', contentHash: 's2', lines: [
    { account: 'buyer:5', amountCents: 4000 }, { account: 'ar_unassigned', amountCents: 1000 }, { account: 'sales_resell', amountCents: -5000, business: 'resell' }] });
  await postEntry(s, U, { date: '2027-05-03', memo: 'payout', source: 'manual', sourceKey: 'p2', contentHash: 'p2', lines: [
    { account: 'undeposited_payouts', amountCents: 5000 }, { account: 'buyer:5', amountCents: -4000 }, { account: 'ar_unassigned', amountCents: -1000 }] });
  const m2 = receiptsByPayer(await s.ledgerLines(U), 2027);
  assert.equal(m2.get('buyer:5')!.receivedCents, 9000 + 4000);
  assert.equal(m2.get('ar_unassigned')!.receivedCents, 1000);
});

test('reports never write: running every report leaves the journal untouched', async () => {
  const { s, lines } = await fixture();
  const before = JSON.stringify(s.entries);
  balanceSheet(lines, '2027-03-31'); cashFlowByMonth(lines); inventoryOnHand(lines, '2027-03-31'); scheduleC(lines, 2027, 'resell'); check1099K(lines, []); toBeancount(lines);
  assert.equal(JSON.stringify(s.entries), before);
});

test('csv: quoting and formula guard; decimal cents', () => {
  assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['=SUM(A1)', 5], [null, '-3']]), 'a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),5\r\n,-3\r\n');
  // a negative amount stays a number; anything else starting with - is still guarded
  assert.equal(toCsv(['a', 'b', 'c'], [['-1234.50', '-2+3', '-cmd']]), 'a,b,c\r\n-1234.50,\'-2+3,\'-cmd\r\n');
  assert.equal(toCsv(['a'], [[decimalCents(-500)]]), 'a\r\n-5.00\r\n');
  assert.equal(decimalCents(-1234567), '-12345.67');
  assert.equal(decimalCents(5), '0.05');
  assert.equal(decimalCents(0), '0.00');
});

test('report csv exports carry integer-cent amounts as decimals and the estimate label', async () => {
  const { lines } = await fixture();
  const bs = balanceSheetCsv(balanceSheet(lines, '2027-03-31'));
  assert.ok(bs.includes('Total assets'));
  assert.ok(bs.split('\r\n').some(r => r.startsWith('Check,,Assets - liabilities - equity,0.00')));
  assert.ok(cashFlowCsv(cashFlowByMonth(lines)).includes('2027-03,930.00,80.00,0.00,500.00,0.00,580.00,1510.00'));
  assert.ok(inventoryCsv(inventoryOnHand(lines, '2027-03-31'), new Map([[2, 'Acme gift cards']])).includes('Acme gift cards'));
  const sc = scheduleCCsv(scheduleC(lines, 2027, 'resell'));
  assert.ok(sc.includes('Not tax advice'));
  assert.ok(sc.includes('1,Gross receipts or sales,90.00'));
  assert.ok(k1099Csv(check1099K(lines, [{ id: 1, year: 2027, payerName: '=evil', payerKeys: 'buyer:5', amountCents: 9000, transactions: null, note: null }])).includes("'=evil"));
});

test('beancount: valid-looking transactions that balance, one open per account, balance assertions match the trial', async () => {
  const { lines } = await fixture();
  const text = toBeancount(lines);
  assert.ok(text.includes('option "operating_currency" "USD"'));
  assert.ok(text.includes('2027-03-01 * "Sale"'));
  assert.ok(text.includes('  entry: '));
  assert.ok(text.includes('    orderId: 1'));
  // parse back: each transaction sums to zero, and the assertions equal the trial balance
  const sums = new Map<string, number>();
  let cur = '';
  let curSum = 0;
  const flush = () => { if (cur) assert.equal(curSum, 0, `transaction ${cur} does not balance`); };
  for (const row of text.split('\n')) {
    if (/^\d{4}-\d{2}-\d{2} \*/.test(row)) { flush(); cur = row; curSum = 0; continue; }
    const m = /^ {2}([A-Z][A-Za-z:0-9-]+)\s+(-?\d+)\.(\d{2}) USD$/.exec(row);
    if (m) { const c = (m[2].startsWith('-') ? -1 : 1) * (Math.abs(Number(m[2])) * 100 + Number(m[3])); curSum += c; sums.set(m[1], (sums.get(m[1]) ?? 0) + c); }
  }
  flush();
  const asserted = new Map<string, number>();
  for (const row of text.split('\n')) {
    const m = /^\d{4}-\d{2}-\d{2} balance (\S+)\s+(-?\d+)\.(\d{2}) USD$/.exec(row);
    if (m) asserted.set(m[1], (m[2].startsWith('-') ? -1 : 1) * (Math.abs(Number(m[2])) * 100 + Number(m[3])));
  }
  const trial = trialBalance(lines);
  for (const r of trial.rows) {
    const name = beancountAccount({ type: r.type, code: r.code, accountName: r.name });
    assert.equal(asserted.get(name), r.balanceCents, name);
    assert.equal(sums.get(name), r.balanceCents, name);
  }
  assert.equal(text.split('\n').filter(l => / open /.test(l)).length, new Set(lines.map(l => l.accountId)).size);
});

test('beancount: account names are valid components and an empty ledger exports a header only', () => {
  assert.equal(beancountAccount({ type: 'asset', code: '1690', accountName: 'Accumulated depreciation (contra)' }), 'Assets:1690-Accumulated-depreciation-contra');
  assert.equal(beancountAccount({ type: 'cogs', code: '5000', accountName: 'COGS - goods' }), 'Expenses:Cogs:5000-COGS-goods');
  assert.equal(beancountAccount({ type: 'liability', code: '2100-12', accountName: 'Card payable - Visa "x"' }), 'Liabilities:2100-12-Card-payable-Visa-x');
  assert.ok(!toBeancount([] as LedgerLineRow[]).includes('open'));
});
