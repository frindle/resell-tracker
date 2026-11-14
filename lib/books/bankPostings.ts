// What bank rows post (source `bank:<txnId>`), built from BankMatch links. Pure: no database.
//
// The one rule that prevents double counting: orders, costs, the tally and the opening post their own entries.
// A bank row linked to one of them posts nothing for that part. A row posts only what no other source covers:
//   - transfers between the user's own accounts (and to/from an unmapped personal account),
//   - personal spending (owner draw / contribution),
//   - the pre-go-live case: a charge for an order dated before go-live (the opening card balance did not include it),
//   - credits that clear cashback receivables (card: Dr card, Cr the receivable; portal: Dr cash, Cr 1310),
//   - Darkbloom payouts (Dr cash, Cr Darkbloom balance 1500).
//   - deposits that clear payouts (Dr cash, Cr 1100 per order; a classified shortfall adds Dr 6000 fee or Dr 4100 returns, Cr 1100).
// A pre-go-live payout's deposit clears 1100 the same way: the opening carried it in undepositedCents. A row with several parts posts ONE entry (`bank:<id>`): same-key
// entries are merged, because the reconciler keeps one entry per sourceKey.
import type { DesiredEntry } from './desired.ts';
import type { AcctRef, LineInput } from './types.ts';

export type BankAcctForBooks = { id: number; creditCardId: number | null; ledgerAccountId: number | null };
export type BankRowForBooks = { id: number; accountId: number; postedDate: string; amountCents: number; pending: boolean; description: string };
export type BankLinkForBooks = { txnId: number; kind: string; refId: number; amountCents: number; note?: string | null };

/** The ledger account a bank account's rows post against, or null when the account is not mapped. */
export function accountRef(a: BankAcctForBooks | undefined): AcctRef | null {
  if (!a) return null;
  if (a.creditCardId != null) return `card:${a.creditCardId}`;
  if (a.ledgerAccountId != null) return a.ledgerAccountId;
  return null;
}

/**
 * A cashback link's note says which receivables it clears: `cb=<cents>,ax=<cents>` (card statement credit: cashback and
 * Amex offer parts) or `portal`. Anything unreadable on a card link is treated as all card cashback.
 */
export function cashbackNote(parts: { cb?: number; ax?: number; portal?: boolean }): string {
  if (parts.portal) return 'portal';
  return [parts.cb ? `cb=${parts.cb}` : '', parts.ax ? `ax=${parts.ax}` : ''].filter(Boolean).join(',');
}
export function parseCashbackNote(note: string | null | undefined, amount: number): { cb: number; ax: number; portal: number } {
  if (note === 'portal') return { cb: 0, ax: 0, portal: amount };
  const cb = Number(/(?:^|,)cb=(\d+)/.exec(note ?? '')?.[1] ?? 0);
  const ax = Number(/(?:^|,)ax=(\d+)/.exec(note ?? '')?.[1] ?? 0);
  return cb + ax === amount && cb + ax > 0 ? { cb, ax, portal: 0 } : { cb: amount, ax: 0, portal: 0 };
}

export const isMapped = (a: BankAcctForBooks | undefined) => accountRef(a) != null;

/** A payout_shortfall link's note: `shortfall:fee|returns|more`. Anything else posts nothing (the order stays undeposited). */
export const shortfallClass = (note: string | null | undefined): 'fee' | 'returns' | 'more' | null => {
  const m = /^shortfall:(fee|returns|more)$/.exec(note ?? '');
  return m ? (m[1] as 'fee' | 'returns' | 'more') : null;
};

const SHARED = 'shared' as const;
const ln = (account: AcctRef, amountCents: number, memo?: string): LineInput => ({ account, amountCents, business: SHARED, memo: memo ?? null });

/** Entry for money moving between two rows (or one row and a personal account). null when nothing should post. */
function transferLines(row: BankRowForBooks, other: BankRowForBooks | undefined, accts: Map<number, BankAcctForBooks>, amount: number): LineInput[] | null {
  const mine = accountRef(accts.get(row.accountId));
  const theirs = other ? accountRef(accts.get(other.accountId)) : null;
  if (mine != null && theirs != null && other) {
    if (Math.sign(row.amountCents) === Math.sign(other.amountCents)) return null;
    const [pos, neg] = row.amountCents > 0 ? [mine, theirs] : [theirs, mine];
    return [ln(pos, amount), ln(neg, -amount)];
  }
  const ref = mine ?? theirs;
  if (ref == null) return null;
  const amt = mine != null ? row.amountCents : other!.amountCents;
  return amt < 0 ? [ln('owner_draws', amount), ln(ref, -amount)] : [ln(ref, amount), ln('owner_contributions', -amount)];
}

export function desiredBankEntries(input: {
  rows: BankRowForBooks[];
  links: BankLinkForBooks[];
  accounts: BankAcctForBooks[];
  /** order id -> its order day (YYYY-MM-DD), for the pre-go-live rule */
  orderDays: Map<number, string>;
  goLive: string;
}): DesiredEntry[] {
  const { goLive } = input;
  const rows = new Map(input.rows.map(r => [r.id, r]));
  const accts = new Map(input.accounts.map(a => [a.id, a]));
  const byTxn = new Map<number, BankLinkForBooks[]>();
  for (const l of input.links) (byTxn.get(l.txnId) ?? byTxn.set(l.txnId, []).get(l.txnId)!).push(l);
  const out: DesiredEntry[] = [];

  for (const row of [...input.rows].sort((a, b) => a.id - b.id)) {
    if (row.pending || row.postedDate < goLive) continue;
    const links = byTxn.get(row.id) ?? [];
    const ref = accountRef(accts.get(row.accountId));

    // Transfers: posted once, on the lower id, dated the earlier of the two rows.
    for (const l of links.filter(x => x.kind === 'transfer')) {
      const other = rows.get(l.refId);
      if (other && other.id < row.id) continue; // the lower id's turn posts it
      if (other && other.pending) continue;
      const date = other && other.postedDate < row.postedDate ? other.postedDate : row.postedDate;
      if (date < goLive) continue;
      const lines = transferLines(row, other, accts, l.amountCents);
      if (!lines) continue;
      out.push({ sourceKey: `bank:${row.id}`, date, memo: `Transfer, ${row.description}`, source: 'bank', lines });
    }

    // Personal: on a mapped account only. A debit is a draw, a credit is a contribution.
    const personal = links.find(x => x.kind === 'personal');
    if (personal && ref != null) {
      const a = personal.amountCents;
      const lines = row.amountCents < 0 ? [ln('owner_draws', a), ln(ref, -a)] : [ln(ref, a), ln('owner_contributions', -a)];
      out.push({ sourceKey: `bank:${row.id}`, date: row.postedDate, memo: `Personal, ${row.description}`, source: 'bank', lines });
    }

    // Before go-live: a charge for an order dated before it. The opening carried the inventory but not the card
    // balance, so the charge clears opening balance equity.
    if (ref != null && row.amountCents < 0) {
      let pre = 0;
      for (const l of links) {
        if (l.kind !== 'order_charge') continue;
        const day = input.orderDays.get(l.refId);
        if (day != null && day < goLive) pre += l.amountCents;
      }
      if (pre > 0) {
        out.push({
          sourceKey: `bank:${row.id}:opening`, date: row.postedDate, memo: `Charge for an order before go-live, ${row.description}`, source: 'bank',
          lines: [ln('opening_balance_equity', pre), ln(ref, -pre)],
        });
      }
    }
    // Cashback credit and Darkbloom payout: credits on a mapped account.
    if (ref != null && row.amountCents > 0) {
      for (const l of links) {
        if (l.kind === 'cashback') {
          const p = parseCashbackNote(l.note, l.amountCents);
          const lines: LineInput[] = [ln(ref, l.amountCents)];
          if (p.cb) lines.push({ ...ln('cashback_card_recv', -p.cb), orderId: l.refId });
          if (p.ax) lines.push({ ...ln('amex_offer_recv', -p.ax), orderId: l.refId });
          if (p.portal) lines.push({ ...ln('cashback_portal_recv', -p.portal), orderId: l.refId });
          out.push({ sourceKey: `bank:${row.id}`, date: row.postedDate, memo: `Cashback received, ${row.description}`, source: 'bank', lines });
        } else if (l.kind === 'darkbloom') {
          out.push({ sourceKey: `bank:${row.id}`, date: row.postedDate, memo: `Darkbloom payout, ${row.description}`, source: 'bank', lines: [ln(ref, l.amountCents), ln('darkbloom_balance', -l.amountCents)] });
        }
      }
    }
    // Deposit: cash in, 1100 out per order; a fee or returns shortfall is the rest of what the buyer owed us on that order.
    if (ref != null && row.amountCents > 0) {
      const pays = links.filter(l => l.kind === 'payout');
      if (pays.length > 0) {
        const cash = pays.reduce((a, l) => a + l.amountCents, 0);
        const lines: LineInput[] = [ln(ref, cash)];
        for (const l of pays) lines.push({ ...ln('undeposited_payouts', -l.amountCents), orderId: l.refId, business: 'resell' });
        for (const l of links.filter(x => x.kind === 'payout_shortfall')) {
          const c = shortfallClass(l.note);
          if (c !== 'fee' && c !== 'returns') continue;
          lines.push({ ...ln(c === 'fee' ? 'exp_commissions' : 'returns_allowances', l.amountCents), orderId: l.refId, business: 'resell', memo: `Payout shortfall (${c})` });
          lines.push({ ...ln('undeposited_payouts', -l.amountCents), orderId: l.refId, business: 'resell' });
        }
        out.push({ sourceKey: `bank:${row.id}`, date: row.postedDate, memo: `Payout deposit, ${row.description}`, source: 'bank', lines });
      }
    }
    // order_charge (rest), order_refund, cost, reversal_pair, ignore: nothing here, the order / cost / return posts it.
  }
  return mergeSameKey(out);
}

/** One entry per sourceKey: a row with two parts (transfer + personal, several cashback links) must not lose one. */
export function mergeSameKey(entries: DesiredEntry[]): DesiredEntry[] {
  const byKey = new Map<string, DesiredEntry>();
  for (const e of entries) {
    const prev = byKey.get(e.sourceKey);
    if (!prev) { byKey.set(e.sourceKey, e); continue; }
    byKey.set(e.sourceKey, {
      ...prev,
      date: e.date < prev.date ? e.date : prev.date,
      memo: prev.memo.split('; ').includes(e.memo) ? prev.memo : `${prev.memo}; ${e.memo}`,
      lines: [...prev.lines, ...e.lines],
    });
  }
  return [...byKey.values()];
}

