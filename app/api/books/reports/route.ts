import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { PrismaStore } from '@/lib/books/prismaStore';
import { DAY_RE, laDay } from '@/lib/books/dates';
import { pnlByMonth, trialBalance } from '@/lib/books/reports';
import { balanceSheet } from '@/lib/books/balanceSheet';
import { cashBalance, cashFlowByMonth } from '@/lib/books/cashFlow';
import { inventoryOnHand } from '@/lib/books/inventory';
import { scheduleC, SCHEDULE_C_DISCLAIMER } from '@/lib/books/scheduleC';
import { check1099K, K1099_REFERENCE } from '@/lib/books/k1099';
import { toBeancount } from '@/lib/books/beancount';
import { balanceSheetCsv, cashFlowCsv, inventoryCsv, k1099Csv, pnlCsv, scheduleCCsv, trialCsv } from '@/lib/books/reportExports';
import { toCsv } from '@/lib/books/csv';

// Read-only: every report is computed from the ledger and nothing here writes an entry. Not on the extension allow-list.
const DISCLAIMER = 'Bookkeeping estimate for your records. Not tax advice.';

function file(body: string, name: string, type: string) {
  return new Response(body, { headers: {
    'Content-Type': `${type}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  } });
}

export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const sp = req.nextUrl.searchParams;
    const type = sp.get('type') ?? '';
    const csv = sp.get('format') === 'csv';
    const today = laDay(new Date());
    const asOf = sp.get('asOf') || today;
    const year = Number(sp.get('year') || today.slice(0, 4));
    if (!DAY_RE.test(asOf)) return Response.json({ error: 'bad date' }, { status: 400 });
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return Response.json({ error: 'bad year' }, { status: 400 });
    const store = new PrismaStore();
    const lines = await store.ledgerLines(userId);
    const upTo = lines.filter(l => l.date <= asOf);

    switch (type) {
      case 'balance-sheet': {
        const r = balanceSheet(lines, asOf);
        return csv ? file(balanceSheetCsv(r), `balance-sheet-${asOf}.csv`, 'text/csv') : Response.json({ disclaimer: DISCLAIMER, ...r });
      }
      case 'cash-flow': {
        const rows = cashFlowByMonth(lines);
        const tie = cashBalance(lines);
        return csv ? file(cashFlowCsv(rows), 'cash-flow.csv', 'text/csv')
          : Response.json({ disclaimer: DISCLAIMER, months: rows, cashBalanceCents: tie, differenceCents: (rows.at(-1)?.endCents ?? 0) - tie });
      }
      case 'inventory': {
        const ids = [...new Set(upTo.filter(l => l.systemKey?.startsWith('inventory_') && l.orderId != null).map(l => l.orderId!))];
        const orders = ids.length ? await prisma.order.findMany({ where: { userId, id: { in: ids } }, select: { id: true, platform: true, orderNumber: true, itemDescription: true, orderDate: true } }) : [];
        const dates = new Map(orders.map(o => [o.id, laDay(o.orderDate)]));
        const labels = new Map(orders.map(o => [o.id, [o.platform, o.orderNumber, o.itemDescription].filter(Boolean).join(' ')]));
        const r = inventoryOnHand(lines, asOf, dates);
        return csv ? file(inventoryCsv(r, labels), `inventory-${asOf}.csv`, 'text/csv')
          : Response.json({ disclaimer: DISCLAIMER, ...r, lots: r.lots.map(l => ({ ...l, label: l.orderId != null ? labels.get(l.orderId) ?? '' : '' })) });
      }
      case 'schedule-c': {
        const biz = sp.get('business');
        if (csv) {
          if (biz !== 'resell' && biz !== 'darkbloom') return Response.json({ error: 'business must be resell or darkbloom' }, { status: 400 });
          return file(scheduleCCsv(scheduleC(lines, year, biz)), `schedule-c-${biz}-${year}.csv`, 'text/csv');
        }
        return Response.json({ disclaimer: SCHEDULE_C_DISCLAIMER, year, resell: scheduleC(lines, year, 'resell'), darkbloom: scheduleC(lines, year, 'darkbloom') });
      }
      case '1099k': {
        const rows = await prisma.form1099K.findMany({ where: { userId }, orderBy: [{ year: 'desc' }, { payerName: 'asc' }] });
        const checked = check1099K(lines, rows.map(r => ({ id: r.id, year: r.year, payerName: r.payerName, payerKeys: r.payerKeys, amountCents: r.amountCents, transactions: r.transactions, note: r.note })));
        if (csv) return file(k1099Csv(checked), '1099k-check.csv', 'text/csv');
        const accts = await store.listAccounts(userId);
        const payers = [
          ...accts.filter(a => a.systemKey?.startsWith('buyer:')).map(a => ({ key: a.systemKey!, name: a.name.replace(/^Receivable - /, '') })),
          { key: 'ar_unassigned', name: 'Orders with no buyer' }, { key: 'darkbloom', name: 'Darkbloom earnings' },
        ];
        return Response.json({ disclaimer: DISCLAIMER, reference: K1099_REFERENCE, payers, rows: checked });
      }
      case 'trial': {
        const t = trialBalance(upTo);
        return csv ? file(trialCsv(t.rows), `trial-balance-${asOf}.csv`, 'text/csv') : Response.json({ disclaimer: DISCLAIMER, ...t });
      }
      case 'pnl': {
        const rows = pnlByMonth(lines);
        return csv ? file(pnlCsv(rows), 'profit-and-loss.csv', 'text/csv') : Response.json({ disclaimer: DISCLAIMER, rows });
      }
      case 'journal': {
        // Flat CSV of every journal line, for a spreadsheet check next to the Beancount file.
        return file(toCsv(['Entry', 'Date', 'Source', 'Memo', 'Code', 'Account', 'Order', 'Debit +, credit -'],
          lines.map(l => [l.entryId, l.date, l.source, l.entryMemo, l.code, l.accountName, l.orderId, (l.amountCents / 100).toFixed(2)])), 'journal.csv', 'text/csv');
      }
      case 'beancount':
        return file(toBeancount(lines), 'books.beancount', 'text/plain');
      default:
        return Response.json({ error: 'unknown report type' }, { status: 400 });
    }
  });
}
