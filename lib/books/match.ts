// Matching suggestions for bank transactions. Pure functions: no database, no journal posting.
// Accepting or ignoring a suggestion only changes BankTransaction.matchStatus (posting from bank rows is a later phase).
//
// Order (docs: Resell Accounting, "Matching"): 1. transfers between the user's own accounts, 2. card charge -> order.
// A card payment made from a bank account is a transfer, never an expense, so rule 1 runs first and claims it.

export type MatchTxn = {
  id: number;
  accountId: number;
  postedDate: string; // YYYY-MM-DD
  amountCents: number; // signed from the account holder's view
  description: string;
  matchStatus: string; // unmatched | suggested | matched | ignored
};

export type MatchAccount = {
  id: number;
  last4: string | null;
  creditCardId: number | null;
};

export type MatchOrder = {
  id: number;
  platform: string;
  orderNumber: string | null;
  orderDate: string; // YYYY-MM-DD (Los Angeles)
  cardId: number | null;
  cost: number; // dollars, as stored
  shippingCost: number;
  insuranceCost: number;
  taxAmount: number | null;
  subtotalAmount: number | null;
  cancelled: boolean;
};

export type CardLastFours = Map<number, Set<string>>; // CreditCard.id -> all last4s (CreditCard.last4 + CreditCardLastFour)

export const TRANSFER_DAYS = 5;
export const CHARGE_MIN_DAYS = 0;
export const CHARGE_MAX_DAYS = 5;
/** Highest US combined sales tax rate we allow when an order's tax is unknown (a bit over the 10.25% LA-area rate). */
export const TAX_WINDOW_RATE = 0.115;

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const open = (t: MatchTxn) => t.matchStatus === 'unmatched' || t.matchStatus === 'suggested';
const cents = (d: number) => Math.round(d * 100 + (d < 0 ? -1e-9 : 1e-9));

// ---- Rule 1: transfers ----

export type TransferPair = { aId: number; bId: number; days: number };

/**
 * Pairs of open transactions in two different accounts with the same amount, opposite signs, posted within 5 days.
 * Each transaction is in at most one pair; the closest dates win, ties go to the lower ids.
 */
export function suggestTransfers(txns: MatchTxn[]): TransferPair[] {
  const cand = txns.filter(t => open(t) && t.amountCents !== 0);
  const byAbs = new Map<number, MatchTxn[]>();
  for (const t of cand) {
    const k = Math.abs(t.amountCents);
    (byAbs.get(k) ?? byAbs.set(k, []).get(k)!).push(t);
  }
  const all: TransferPair[] = [];
  for (const group of byAbs.values()) {
    const neg = group.filter(t => t.amountCents < 0);
    const pos = group.filter(t => t.amountCents > 0);
    for (const n of neg) for (const p of pos) {
      if (n.accountId === p.accountId) continue;
      const days = Math.abs(dayDiff(n.postedDate, p.postedDate));
      if (days <= TRANSFER_DAYS) all.push({ aId: n.id, bId: p.id, days });
    }
  }
  all.sort((x, y) => x.days - y.days || Math.min(x.aId, x.bId) - Math.min(y.aId, y.bId) || x.aId - y.aId || x.bId - y.bId);
  const used = new Set<number>();
  const out: TransferPair[] = [];
  for (const p of all) {
    if (used.has(p.aId) || used.has(p.bId)) continue;
    used.add(p.aId); used.add(p.bId);
    out.push(p);
  }
  return out;
}

// ---- Rule 2: card charge -> order ----

export type ChargeCandidate = { orderId: number; exact: boolean };
export type ChargeSuggestion = { txnId: number; candidates: ChargeCandidate[] };

const RETAILER_WORDS: Record<string, RegExp> = {
  amazon: /amzn|amazon/i,
  walmart: /wal[\s-]?mart|wmt/i,
  costco: /costco/i,
  'best buy': /best\s?buy|bestbuy/i,
  target: /\btarget\b/i,
};

function retailerHit(platform: string, description: string): boolean {
  const p = platform.toLowerCase();
  for (const [k, re] of Object.entries(RETAILER_WORDS)) if (p.includes(k)) return re.test(description);
  const w = p.replace(/[^a-z0-9]+/g, ' ').trim();
  return w.length >= 3 && description.toLowerCase().includes(w);
}

function orderNumberHit(orderNumber: string | null, description: string): boolean {
  if (!orderNumber) return false;
  const digits = orderNumber.replace(/\D/g, '');
  if (digits.length < 6) return false;
  return description.replace(/\D/g, '').includes(digits) || description.includes(orderNumber);
}

/**
 * The amounts (cents) this order's card charge can be. When both subtotal and tax are known the charge is subtotal+tax
 * (+ shipping and insurance), exactly. Otherwise `cost` may or may not already include tax (the Amazon/Walmart importers
 * include it, CSV imports and some manual entries don't), so the charge is anywhere from cost to cost plus
 * TAX_WINDOW_RATE of it.
 */
export function expectedChargeCents(o: MatchOrder): { min: number; max: number; exact: boolean } {
  const extras = cents(o.shippingCost) + cents(o.insuranceCost);
  if (o.subtotalAmount != null && o.taxAmount != null) {
    const v = cents(o.subtotalAmount) + cents(o.taxAmount) + extras;
    return { min: v, max: v, exact: true };
  }
  const base = cents(o.cost) + extras;
  return { min: base, max: base + Math.round(base * TAX_WINDOW_RATE), exact: false };
}

/**
 * For each open charge (negative amount) on an account tied to a card: the orders on that card, dated 0-5 days before
 * the posting, whose expected amount fits. One candidate or several are both reported (the caller marks the transaction
 * 'suggested' and lists them). An order number or retailer name in the description narrows several candidates when it
 * singles out some of them. Orders in `takenOrderIds` (already matched) are skipped.
 */
export function suggestCharges(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours, takenOrderIds: Set<number> = new Set(),
): ChargeSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const out: ChargeSuggestion[] = [];
  for (const t of txns) {
    if (!open(t) || t.amountCents >= 0) continue;
    const a = acct.get(t.accountId);
    if (!a || (a.creditCardId == null && !a.last4)) continue;
    const charge = -t.amountCents;
    let found: (ChargeCandidate & { o: MatchOrder })[] = [];
    for (const o of orders) {
      if (o.cancelled || o.cardId == null || takenOrderIds.has(o.id)) continue;
      const sameCard = a.creditCardId === o.cardId || (a.last4 != null && (cardLastFours.get(o.cardId)?.has(a.last4) ?? false));
      if (!sameCard) continue;
      const d = dayDiff(o.orderDate, t.postedDate);
      if (d < CHARGE_MIN_DAYS || d > CHARGE_MAX_DAYS) continue;
      const e = expectedChargeCents(o);
      if (charge < e.min || charge > e.max) continue;
      found.push({ orderId: o.id, exact: e.exact || charge === e.min, o });
    }
    if (found.length === 0) continue;
    if (found.length > 1) {
      const byNum = found.filter(f => orderNumberHit(f.o.orderNumber, t.description));
      if (byNum.length > 0) found = byNum;
      else {
        const byShop = found.filter(f => retailerHit(f.o.platform, t.description));
        if (byShop.length > 0) found = byShop;
      }
    }
    found.sort((x, y) => Number(y.exact) - Number(x.exact) || x.orderId - y.orderId);
    out.push({ txnId: t.id, candidates: found.map(f => ({ orderId: f.orderId, exact: f.exact })) });
  }
  return out;
}

export type Suggestion =
  | { kind: 'transfer'; txnId: number }
  | { kind: 'order'; orderIds: number[] };

/** Run both rules in order; a transaction claimed by rule 1 is not offered to rule 2. Returns txnId -> suggestion. */
export function suggestAll(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours, takenOrderIds: Set<number> = new Set(),
): Map<number, Suggestion> {
  const out = new Map<number, Suggestion>();
  const pairs = suggestTransfers(txns);
  for (const p of pairs) {
    out.set(p.aId, { kind: 'transfer', txnId: p.bId });
    out.set(p.bId, { kind: 'transfer', txnId: p.aId });
  }
  const rest = txns.filter(t => !out.has(t.id));
  for (const s of suggestCharges(rest, accounts, orders, cardLastFours, takenOrderIds)) {
    out.set(s.txnId, { kind: 'order', orderIds: s.candidates.map(c => c.orderId) });
  }
  return out;
}
