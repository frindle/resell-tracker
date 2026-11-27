// 1099-K check: the amount a payer reported for a year against the books' gross receipts from that payer.
// Reads ledger lines; the 1099-K amounts are entered by the user (Form1099K rows). Information only: the IRS
// reference threshold ($20,000 and more than 200 transactions, IRS FS-2025-08) is shown, never enforced.
import type { LedgerLineRow } from './types.ts';

export const K1099_REFERENCE = { amountCents: 2_000_000, transactions: 200, source: 'IRS FS-2025-08' } as const;

export type K1099Input = { id: number; year: number; payerName: string; payerKeys: string; amountCents: number; transactions: number | null; note: string | null };

/** Payer keys the books can tell apart: a buyer ("buyer:5"), "ar_unassigned", "darkbloom". */
export function payerKeyOfEntry(entryLines: LedgerLineRow[]): string {
  const buyer = entryLines.find(l => (l.systemKey ?? '').startsWith('buyer:'));
  if (buyer) return buyer.systemKey!;
  if (entryLines.some(l => l.systemKey === 'ar_unassigned')) return 'ar_unassigned';
  if (entryLines.some(l => l.systemKey === 'darkbloom_earnings')) return 'darkbloom';
  return 'other';
}

export type PayerReceipts = { key: string; grossCents: number; receivedCents: number };

/**
 * Per payer for a calendar year:
 *  - grossCents: sales and Darkbloom earnings credited in the year (reversals net out), before returns
 *  - receivedCents: money applied against that payer's receivable by a payout (an entry that debits undeposited
 *    payouts or a cash account), the closer analogue of "payments received"
 */
export function receiptsByPayer(lines: LedgerLineRow[], year: number): Map<string, PayerReceipts> {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const byEntry = new Map<number, LedgerLineRow[]>();
  for (const l of lines) {
    if (l.date < from || l.date > to) continue;
    const a = byEntry.get(l.entryId);
    if (a) a.push(l); else byEntry.set(l.entryId, [l]);
  }
  const out = new Map<string, PayerReceipts>();
  const get = (k: string) => { let r = out.get(k); if (!r) { r = { key: k, grossCents: 0, receivedCents: 0 }; out.set(k, r); } return r; };
  for (const ls of byEntry.values()) {
    const key = payerKeyOfEntry(ls);
    for (const l of ls) {
      if (l.systemKey === 'sales_resell' || l.systemKey === 'darkbloom_earnings') get(key).grossCents -= l.amountCents;
    }
    const cashIn = ls.some(l => l.systemKey === 'undeposited_payouts' || (l.type === 'asset' && /^10\d\d$/.test(l.code)));
    if (cashIn) {
      for (const l of ls) if ((l.systemKey ?? '').startsWith('buyer:') || l.systemKey === 'ar_unassigned') get(key).receivedCents -= l.amountCents;
    }
  }
  return out;
}

export type K1099Row = K1099Input & {
  booksGrossCents: number;
  booksReceivedCents: number;
  differenceCents: number; // 1099-K amount - books gross receipts
  status: 'match' | 'form_higher' | 'books_higher';
  reference: { overAmount: boolean; overTransactions: boolean | null; meets: boolean | null };
};

export function check1099K(lines: LedgerLineRow[], entries: K1099Input[]): K1099Row[] {
  const cache = new Map<number, Map<string, PayerReceipts>>();
  return entries.map(e => {
    let m = cache.get(e.year);
    if (!m) { m = receiptsByPayer(lines, e.year); cache.set(e.year, m); }
    const keys = e.payerKeys.split(',').map(s => s.trim()).filter(Boolean);
    const gross = keys.reduce((s, k) => s + (m!.get(k)?.grossCents ?? 0), 0);
    const recv = keys.reduce((s, k) => s + (m!.get(k)?.receivedCents ?? 0), 0);
    const diff = e.amountCents - gross;
    const overAmount = e.amountCents > K1099_REFERENCE.amountCents;
    const overTx = e.transactions == null ? null : e.transactions > K1099_REFERENCE.transactions;
    return {
      ...e, booksGrossCents: gross, booksReceivedCents: recv, differenceCents: diff,
      status: diff === 0 ? 'match' : diff > 0 ? 'form_higher' : 'books_higher',
      reference: { overAmount, overTransactions: overTx, meets: overTx == null ? null : overAmount && overTx },
    };
  });
}
