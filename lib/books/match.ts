// Matching suggestions for bank transactions. Pure functions: no database, no journal posting.
// Accepting a suggestion writes BankMatch links (bank/service.ts); posting from those links is bankPostings.ts.
//
// Order (docs: Resell P3 Matching Spec, "Matching, in order"): 1. transfers between the user's own accounts,
// 2. card charges to orders (1:1, then split shipments N:1; a charge pays at most one order, and an order may be paid
//    by several charges over time),
// 3. refunds to returns, then same-card charge-and-refund pairs.
// A card payment made from a bank account is a transfer, never an expense, so rule 1 runs first and claims it.
// 5. cashback credits on a card (open card-cashback / Amex-offer receivables), 8. user rules (matchRules, run by the caller
// on what is left; portal-cashback rules then go through suggestPortalCashback).
// 4. deposits to payouts (bank credits on a mapped non-card account) run before cashback.

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
  /** Charges already linked to this order (cents). An order can be paid in parts; it is offered until these reach its amount. */
  linkedCents?: number;
  /** The order's notes carry a "PayPal: paid with" line: it was paid through PayPal. */
  paypal?: boolean;
  /** YYYY-MM-DD (Los Angeles) of the earliest shipping email for the order's tracking numbers; absent when unknown. */
  shipDay?: string | null;
};

/** A return with status 'refunded', for refund matching. */
export type MatchReturn = {
  id: number;
  orderId: number;
  cardId: number | null;
  refundCents: number;
  refundedDate: string | null; // YYYY-MM-DD
  /** Credits already linked to this return (cents). A refund can arrive in parts. */
  linkedCents?: number;
};

export type CardLastFours = Map<number, Set<string>>; // CreditCard.id -> all last4s (CreditCard.last4 + CreditCardLastFour)

export const TRANSFER_DAYS = 5;
export const CHARGE_MIN_DAYS = 0;
/** Charges to orders: 0-7 days after the order date, for one charge or a split shipment alike. */
export const CHARGE_MAX_DAYS = 7;
/** Highest US combined sales tax rate we allow when an order's tax is unknown (a bit over the 10.25% LA-area rate). */
export const TAX_WINDOW_RATE = 0.115;
/** Split shipments: more than 8 candidate charges goes to the inbox. */
export const SPLIT_MAX_CHARGES = 8;
/** Split shipments: more combinations than this that fit is a guess, not a match; the rows stay in the inbox. */
export const SPLIT_MAX_OPTIONS = 3;
export const REFUND_MAX_DAYS = 10;
export const PAIR_DAYS = 30;

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const open = (t: MatchTxn) => t.matchStatus === 'unmatched' || t.matchStatus === 'suggested';
const cents = (d: number) => Math.round(d * 100 + (d < 0 ? -1e-9 : 1e-9));

// ---- Rule 1: transfers ----

export type TransferPair = { aId: number; bId: number; days: number };

/**
 * Pairs of open transactions in two different accounts with the same amount, opposite signs, posted within 5 days.
 * A debit on a card account is a purchase, never a transfer: a card only takes part as the credit (a payment to it).
 * Otherwise a charge for an order and the buyer's payout for it (same amount, days apart) pair up.
 * A row whose description names one of the other accounts by its last four ("To Savings 2022") pairs only with that
 * account, and such pairs go first. Then the closest dates win, ties go to the lower ids.
 */
export function suggestTransfers(txns: MatchTxn[], accounts: MatchAccount[] = []): TransferPair[] {
  const cards = new Set(accounts.filter(a => a.creditCardId != null).map(a => a.id));
  const byLast4 = new Map<string, number[]>();
  for (const a of accounts) if (a.last4 && /^\d{4}$/.test(a.last4)) (byLast4.get(a.last4) ?? byLast4.set(a.last4, []).get(a.last4)!).push(a.id);
  /** The other accounts a description names by last four. */
  const named = (t: MatchTxn) => new Set((t.description.match(/(?<!\d)\d{4}(?!\d)/g) ?? []).flatMap(d => byLast4.get(d) ?? []).filter(id => id !== t.accountId));
  const cand = txns.filter(t => open(t) && t.amountCents !== 0 && !(t.amountCents < 0 && cards.has(t.accountId)));
  const names = new Map(cand.map(t => [t.id, named(t)]));
  const byAbs = new Map<number, MatchTxn[]>();
  for (const t of cand) {
    const k = Math.abs(t.amountCents);
    (byAbs.get(k) ?? byAbs.set(k, []).get(k)!).push(t);
  }
  const all: (TransferPair & { hits: number })[] = [];
  for (const group of byAbs.values()) {
    const neg = group.filter(t => t.amountCents < 0);
    const pos = group.filter(t => t.amountCents > 0);
    for (const n of neg) for (const p of pos) {
      if (n.accountId === p.accountId) continue;
      const nn = names.get(n.id)!, pn = names.get(p.id)!;
      if ((nn.size && !nn.has(p.accountId)) || (pn.size && !pn.has(n.accountId))) continue;
      const days = Math.abs(dayDiff(n.postedDate, p.postedDate));
      if (days <= TRANSFER_DAYS) all.push({ aId: n.id, bId: p.id, days, hits: (nn.size ? 1 : 0) + (pn.size ? 1 : 0) });
    }
  }
  all.sort((x, y) => y.hits - x.hits || x.days - y.days || Math.min(x.aId, x.bId) - Math.min(y.aId, y.bId) || x.aId - y.aId || x.bId - y.bId);
  const used = new Set<number>();
  const out: TransferPair[] = [];
  for (const p of all) {
    if (used.has(p.aId) || used.has(p.bId)) continue;
    used.add(p.aId); used.add(p.bId);
    out.push({ aId: p.aId, bId: p.bId, days: p.days });
  }
  return out;
}

// ---- Rule 2: card charge -> order ----

export type ChargeCandidate = { orderId: number; exact: boolean };
export type ChargeSuggestion = { txnId: number; candidates: ChargeCandidate[]; /** Set when pairTwins narrowed this charge to one of a set of interchangeable orders. */ twin?: boolean };

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
  if (w.length >= 3 && description.toLowerCase().includes(w)) return true;
  // "Sam's Club" vs "SAMSCLUB #4708": the letters and digits alone
  const c = p.replace(/[^a-z0-9]+/g, '');
  return c.length >= 4 && description.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(c);
}

function orderNumberHit(orderNumber: string | null, description: string): boolean {
  if (!orderNumber) return false;
  const digits = orderNumber.replace(/\D/g, '');
  if (digits.length < 6) return false;
  return description.replace(/\D/g, '').includes(digits) || description.includes(orderNumber);
}

/** The order's notes carry the line lib/paypalApply.ts writes for a PayPal payment. */
export function notesShowPayPal(notes: string | null | undefined): boolean {
  return /^PayPal: paid\b/im.test(String(notes ?? ''));
}

/** The bank's description marks the charge as made through PayPal ("PAYPAL *SHOP"). */
export function descriptionIsPayPal(description: string): boolean {
  return /\bpaypal\b/i.test(description);
}

/** Two orders nothing can tell apart: same shop, day, card, amount still to be charged and PayPal status. */
function interchangeable(a: MatchOrder, b: MatchOrder): boolean {
  const ea = remainingChargeCents(a), eb = remainingChargeCents(b);
  return a.platform.trim().toLowerCase() === b.platform.trim().toLowerCase() && a.orderDate === b.orderDate && a.cardId === b.cardId
    && ea.min === eb.min && ea.max === eb.max && ea.exact === eb.exact && !!a.paypal === !!b.paypal
    && (a.shipDay ?? null) === (b.shipDay ?? null);
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

function sameCard(a: MatchAccount, cardId: number, cardLastFours: CardLastFours): boolean {
  return a.creditCardId === cardId || (a.last4 != null && (cardLastFours.get(cardId)?.has(a.last4) ?? false));
}

/** What is still to be charged for this order: its expected amount less the charges already linked to it. */
export function remainingChargeCents(o: MatchOrder): { min: number; max: number; exact: boolean } {
  const e = expectedChargeCents(o);
  const linked = o.linkedCents ?? 0;
  return { min: e.min - linked, max: e.max - linked, exact: e.exact };
}

/** Paid in full by linked charges: no more charges are offered for it. */
export function orderCovered(o: MatchOrder): boolean {
  return (o.linkedCents ?? 0) >= expectedChargeCents(o).min;
}

/** Is this charge close enough to the order? 0-7 days after the order date. */
export function inChargeWindow(o: MatchOrder, t: Pick<MatchTxn, 'postedDate'>): boolean {
  const d = dayDiff(o.orderDate, t.postedDate);
  return d >= CHARGE_MIN_DAYS && d <= CHARGE_MAX_DAYS;
}

/**
 * For each open charge (negative amount) on an account tied to a card: the orders on that card, dated 0-7 days before
 * the posting, whose amount still to be charged fits (an order paid in part offers only what is left). One candidate or several are both reported (the caller marks the transaction
 * 'suggested' and lists them). An order number or retailer name in the description narrows several candidates when it
 * singles out some of them. Orders in `takenOrderIds` (already matched) are skipped.
 */
export function suggestCharges(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours, takenOrderIds: Set<number> = new Set(),
): ChargeSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const out: ChargeSuggestion[] = [];
  const ordersOf = new Map<number, MatchOrder[]>();
  for (const t of txns) {
    if (!open(t) || t.amountCents >= 0) continue;
    const a = acct.get(t.accountId);
    if (!a || (a.creditCardId == null && !a.last4)) continue;
    const charge = -t.amountCents;
    let found: (ChargeCandidate & { o: MatchOrder })[] = [];
    for (const o of orders) {
      if (o.cancelled || o.cardId == null || takenOrderIds.has(o.id) || orderCovered(o)) continue;
      if (!sameCard(a, o.cardId, cardLastFours)) continue;
      if (!inChargeWindow(o, t)) continue;
      const e = remainingChargeCents(o);
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
    if (found.length > 1) {
      // Payment method: a PayPal charge goes to orders noted as paid through PayPal, any other charge to those not noted.
      const pp = descriptionIsPayPal(t.description);
      const byMethod = found.filter(f => !!f.o.paypal === pp);
      if (byMethod.length > 0) found = byMethod;
    }
    if (found.length > 1 && found.some(f => f.o.shipDay)) {
      // Some shops charge when the order ships: prefer the orders that shipped 0-2 days before the posting.
      const shipped = found.filter(f => f.o.shipDay && dayDiff(f.o.shipDay, t.postedDate) >= 0 && dayDiff(f.o.shipDay, t.postedDate) <= 2);
      if (shipped.length > 0) found = shipped;
    }
    found.sort((x, y) => Number(y.exact) - Number(x.exact) || x.orderId - y.orderId);
    out.push({ txnId: t.id, candidates: found.map(f => ({ orderId: f.orderId, exact: f.exact })) });
    ordersOf.set(t.id, found.map(f => f.o));
  }
  return pairTwins(out, txns, ordersOf);
}

/**
 * N open charges (same amount, same day) left with the same N interchangeable candidate orders cannot be told apart by
 * anything, and the books come out the same whichever pays which. Pair them one-to-one, charge id with order id both
 * ascending, so each charge is offered one order and can be accepted.
 */
function pairTwins(out: ChargeSuggestion[], txns: MatchTxn[], ordersOf: Map<number, MatchOrder[]>): ChargeSuggestion[] {
  const byTxn = new Map(txns.map(t => [t.id, t]));
  const groups = new Map<string, ChargeSuggestion[]>();
  for (const s of out) {
    if (s.candidates.length < 2) continue;
    const t = byTxn.get(s.txnId)!;
    const key = `${t.amountCents}|${t.postedDate}|${s.candidates.map(c => c.orderId).sort((a, b) => a - b).join(',')}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const sugs of groups.values()) {
    const orders = ordersOf.get(sugs[0].txnId)!;
    if (sugs.length !== orders.length || !orders.every(o => interchangeable(o, orders[0]))) continue;
    const ids = sugs.map(s => s.txnId).sort((a, b) => a - b);
    const oids = orders.map(o => o.id).sort((a, b) => a - b);
    for (const s of sugs) {
      const orderId = oids[ids.indexOf(s.txnId)];
      s.candidates = [s.candidates.find(c => c.orderId === orderId)!];
      s.twin = true;
    }
  }
  return out;
}

/**
 * Twin pairs safe to accept without a person: the set is CLOSED. Its N charges and N orders were paired by pairTwins
 * (identical orders: shop, day, card, amount left, PayPal status, ship day), every order has its full amount open and none
 * is linked or cancelled, and nothing else could be paid by these charges or could pay for these orders: no other open
 * charge of that amount on the card from that shop in the window, no other order (open or cancelled) of that shop on
 * that card in the window that the amount fits.
 */
export function closedTwinPairs(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours, takenOrderIds: Set<number> = new Set(),
): { txnId: number; orderId: number }[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const byId = new Map(orders.map(o => [o.id, o]));
  const sugs = suggestCharges(txns, accounts, orders, cardLastFours, takenOrderIds).filter(s => s.twin);
  const groups = new Map<string, ChargeSuggestion[]>();
  for (const s of sugs) {
    const t = txns.find(x => x.id === s.txnId)!;
    // Card, shop and order day too: two twin sets that only share an amount and a posting day stay apart,
    // so each is checked against the other charges and orders on its own card.
    const o = byId.get(s.candidates[0].orderId)!;
    const key = `${t.amountCents}|${t.postedDate}|${o.cardId}|${o.platform.trim().toLowerCase()}|${o.orderDate}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: { txnId: number; orderId: number }[] = [];
  for (const group of groups.values()) {
    const picked = group.map(s => byId.get(s.candidates[0].orderId)!);
    const ids = new Set(group.map(s => s.txnId)), oids = new Set(picked.map(o => o.id));
    const o0 = picked[0], charge = -txns.find(x => x.id === group[0].txnId)!.amountCents;
    if (oids.size !== group.length) continue;
    if (picked.some(o => o.cancelled || (o.linkedCents ?? 0) !== 0 || takenOrderIds.has(o.id))) continue;
    const post = txns.find(x => x.id === group[0].txnId)!.postedDate;
    const shopSame = (o: MatchOrder) => o.platform.trim().toLowerCase() === o0.platform.trim().toLowerCase();
    const sameCardAs = (a: MatchAccount | undefined) => !!a && o0.cardId != null && sameCard(a, o0.cardId, cardLastFours);
    // another open charge this order's shop could have made
    const otherCharge = txns.some(t => {
      if (ids.has(t.id) || !open(t) || t.amountCents >= 0) return false;
      if (!sameCardAs(acct.get(t.accountId)) || !retailerHit(o0.platform, t.description)) return false;
      return picked.some(o => inChargeWindow(o, t)) && (() => { const e = remainingChargeCents(o0); return -t.amountCents >= e.min && -t.amountCents <= e.max; })();
    });
    // another order (cancelled ones too) that this charge could belong to
    const otherOrder = orders.some(o => {
      if (oids.has(o.id) || o.cardId !== o0.cardId || !shopSame(o) || (!o.cancelled && (takenOrderIds.has(o.id) || orderCovered(o)))) return false;
      if (!inChargeWindow(o, { postedDate: post })) return false;
      const e = remainingChargeCents(o);
      return charge >= e.min && charge <= e.max;
    });
    if (otherCharge || otherOrder) continue;
    for (const s of group) out.push({ txnId: s.txnId, orderId: s.candidates[0].orderId });
  }
  return out;
}

// ---- Rule 2b: split shipments (several charges, one order) ----

export type SplitSuggestion = { orderId: number; subsets: number[][] }; // each subset: txn ids, sorted

/** All subsets (size >= minSize) of `items` whose sum falls in [min, max]. n is small (<= 12), so a bitmask walk is fine. */
function subsetsInRange<T>(items: T[], value: (x: T) => number, min: number, max: number, minSize: number): T[][] {
  const out: T[][] = [];
  const n = items.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0, size = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += value(items[i]); size++; }
    if (size < minSize || sum < min || sum > max) continue;
    out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

/**
 * Amazon, Walmart and Best Buy charge per shipment: several charges from the order's retailer (the description names
 * it) on the order's card, 0-7 days after the order date, that add up to what is still to be charged for the order
 * (exact, or inside the tax window). More than 8 candidate charges: no search, the row stays in the inbox. Two or three
 * different subsets that both fit are all reported, so the caller keeps the rows 'suggested' and the user picks; more
 * than SPLIT_MAX_OPTIONS is a guess and nothing is suggested. `claimedTxnIds` (rows an earlier rule took) are not offered.
 */
export function suggestSplits(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours,
  takenOrderIds: Set<number> = new Set(), claimedTxnIds: Set<number> = new Set(),
): SplitSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const out: SplitSuggestion[] = [];
  const claimed = new Set(claimedTxnIds);
  const charges = txns.filter(t => open(t) && t.amountCents < 0 && !claimed.has(t.id));
  for (const o of [...orders].sort((x, y) => x.id - y.id)) {
    if (o.cancelled || o.cardId == null || takenOrderIds.has(o.id) || orderCovered(o)) continue;
    const cand = charges.filter(t => {
      if (claimed.has(t.id)) return false;
      const a = acct.get(t.accountId);
      if (!a || (a.creditCardId == null && !a.last4)) return false;
      if (!sameCard(a, o.cardId!, cardLastFours)) return false;
      // another shop's charge (a vending machine, a coffee) is never part of this order's shipments
      return inChargeWindow(o, t) && retailerHit(o.platform, t.description);
    });
    if (cand.length < 2 || cand.length > SPLIT_MAX_CHARGES) continue;
    const e = remainingChargeCents(o);
    // A subset must be on one card account (the candidates already are on this order's card; accounts may differ by last4).
    const subs = subsetsInRange(cand, t => -t.amountCents, e.min, e.max, 2)
      .filter(sub => new Set(sub.map(t => t.accountId)).size === 1);
    if (subs.length === 0 || subs.length > SPLIT_MAX_OPTIONS) continue;
    const subsets = subs.map(sub => sub.map(t => t.id).sort((a, b) => a - b));
    out.push({ orderId: o.id, subsets });
    for (const sub of subsets) for (const id of sub) claimed.add(id);
  }
  return out;
}

// ---- Rule 3: refunds to returns, and charge-and-refund pairs ----

export type RefundSuggestion = { txnId: number; candidates: { returnId: number; orderId: number; partial: boolean }[] };

/**
 * A credit (positive amount) on a card account matches a refunded return on that card, 0-10 days after the refund date,
 * when it is no more than what is left of the refund (refunds can arrive in parts). Returns where the credit is exactly
 * what is left win; only when there are none are partial candidates offered. Returns in `takenReturnIds` are refunded
 * in full by linked credits already.
 */
export function suggestRefunds(
  txns: MatchTxn[], accounts: MatchAccount[], returns: MatchReturn[], cardLastFours: CardLastFours, takenReturnIds: Set<number> = new Set(),
): RefundSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const out: RefundSuggestion[] = [];
  for (const t of txns) {
    if (!open(t) || t.amountCents <= 0) continue;
    const a = acct.get(t.accountId);
    if (!a || (a.creditCardId == null && !a.last4)) continue;
    const rest = (r: MatchReturn) => r.refundCents - (r.linkedCents ?? 0);
    const all = returns.filter(r => {
      if (takenReturnIds.has(r.id) || r.cardId == null || r.refundedDate == null || rest(r) <= 0 || t.amountCents > rest(r)) return false;
      if (!sameCard(a, r.cardId, cardLastFours)) return false;
      const d = dayDiff(r.refundedDate, t.postedDate);
      return d >= 0 && d <= REFUND_MAX_DAYS;
    });
    if (all.length === 0) continue;
    const exact = all.filter(r => rest(r) === t.amountCents);
    const cand = (exact.length > 0 ? exact : all).sort((x, y) => x.id - y.id);
    out.push({ txnId: t.id, candidates: cand.map(r => ({ returnId: r.id, orderId: r.orderId, partial: rest(r) !== t.amountCents })) });
  }
  return out;
}

/** The known retailer a description names: its key and the text that matched (what a rule pattern must contain). */
export function retailerHit2(description: string): { key: string; text: string } | null {
  for (const [k, re] of Object.entries(RETAILER_WORDS)) { const m = re.exec(description); if (m) return { key: k, text: m[0].toLowerCase() }; }
  return null;
}

/** A short key for who a row is from: a known retailer's name, else the first letter-word of the description. */
export function merchantKey(description: string): string {
  const known = retailerHit2(description);
  if (known) return known.key;
  const words = description.toLowerCase().replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  return words.slice(0, 1).join(' ');
}

export type PairSuggestion = { chargeId: number; refundId: number; days: number };

/**
 * Two rows on the same card with opposite, equal amounts, the credit 0-30 days after the charge, from the same
 * retailer: a cancelled order, or an authorization that was charged again. Rows on different cards never pair.
 * Each row is in at most one pair; the closest dates win, then the lower ids.
 */
export function suggestPairs(txns: MatchTxn[], accounts: MatchAccount[]): PairSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const isCard = (a: MatchAccount | undefined) => !!a && (a.creditCardId != null || !!a.last4);
  const same = (x: MatchAccount, y: MatchAccount) => x.id === y.id || (x.creditCardId != null && x.creditCardId === y.creditCardId);
  const cand = txns.filter(t => open(t) && t.amountCents !== 0 && isCard(acct.get(t.accountId)));
  const charges = cand.filter(t => t.amountCents < 0);
  const credits = cand.filter(t => t.amountCents > 0);
  const all: PairSuggestion[] = [];
  for (const c of charges) for (const r of credits) {
    if (r.amountCents !== -c.amountCents || !same(acct.get(c.accountId)!, acct.get(r.accountId)!)) continue;
    const days = dayDiff(c.postedDate, r.postedDate);
    if (days < 0 || days > PAIR_DAYS) continue;
    const k = merchantKey(c.description);
    if (!k || k !== merchantKey(r.description)) continue;
    all.push({ chargeId: c.id, refundId: r.id, days });
  }
  all.sort((x, y) => x.days - y.days || x.chargeId - y.chargeId || x.refundId - y.refundId);
  const used = new Set<number>();
  const out: PairSuggestion[] = [];
  for (const p of all) {
    if (used.has(p.chargeId) || used.has(p.refundId)) continue;
    used.add(p.chargeId); used.add(p.refundId);
    out.push(p);
  }
  return out;
}

// ---- Rule 5: cashback credits ----

/** Open cashback receivables of one order (cents): what its books carry less what bank links already cleared. */
export type MatchRecv = { orderId: number; cardId: number | null; orderDate: string; cbCents: number; axCents: number; pcCents: number };
export type CashbackUnit = { orderId: number; cb: number; ax: number; portal: number; cents: number };
/** One way to read a credit. `aggregate`: several orders, oldest first (only ever suggested). */
export type CashbackOption = { units: CashbackUnit[]; aggregate: boolean };
export type CashbackSuggestion = { txnId: number; portal: boolean; options: CashbackOption[] };
/** Portal payments are late: look back this far from the credit. */
export const PORTAL_LOOKBACK_DAYS = 120;

const unit = (orderId: number, cb: number, ax: number, portal: number): CashbackUnit => ({ orderId, cb, ax, portal, cents: cb + ax + portal });

/** Oldest-first prefix of `units` that sums to `amount` exactly (two orders or more), else null. */
function oldestFirstSum(units: (CashbackUnit & { date: string })[], amount: number): CashbackUnit[] | null {
  const sorted = [...units].sort((a, b) => a.date.localeCompare(b.date) || a.orderId - b.orderId);
  let sum = 0;
  const take: CashbackUnit[] = [];
  for (const u of sorted) {
    sum += u.cents;
    take.push({ orderId: u.orderId, cb: u.cb, ax: u.ax, portal: u.portal, cents: u.cents });
    if (sum === amount) return take.length >= 2 ? take : null;
    if (sum > amount) return null;
  }
  return null;
}

/**
 * A credit on a card matches open `cashback_card_recv` / `amex_offer_recv` on that card: one order exact first (its card
 * cashback, its Amex offer, or both), else the oldest-first sum over the card's orders. Several single orders that fit
 * are all reported (the user picks). A sum is only ever suggested.
 */
export function suggestCashbackCredits(txns: MatchTxn[], accounts: MatchAccount[], recvs: MatchRecv[], cardLastFours: CardLastFours): CashbackSuggestion[] {
  const acct = new Map(accounts.map(a => [a.id, a]));
  const out: CashbackSuggestion[] = [];
  for (const t of txns) {
    if (!open(t) || t.amountCents <= 0) continue;
    const a = acct.get(t.accountId);
    if (!a || (a.creditCardId == null && !a.last4)) continue;
    const mine = recvs.filter(r => r.cardId != null && sameCard(a, r.cardId, cardLastFours) && r.orderDate <= t.postedDate && r.cbCents + r.axCents > 0)
      .sort((x, y) => x.orderId - y.orderId);
    const singles: CashbackOption[] = [];
    for (const r of mine) {
      const fit = r.cbCents === t.amountCents ? unit(r.orderId, r.cbCents, 0, 0)
        : r.axCents === t.amountCents ? unit(r.orderId, 0, r.axCents, 0)
        : r.cbCents + r.axCents === t.amountCents ? unit(r.orderId, r.cbCents, r.axCents, 0) : null;
      if (fit) singles.push({ units: [fit], aggregate: false });
    }
    if (singles.length > 0) { out.push({ txnId: t.id, portal: false, options: singles }); continue; }
    const agg = oldestFirstSum(mine.map(r => ({ ...unit(r.orderId, r.cbCents, r.axCents, 0), date: r.orderDate })), t.amountCents);
    if (agg) out.push({ txnId: t.id, portal: false, options: [{ units: agg, aggregate: true }] });
  }
  return out;
}

/**
 * Portal payments (Rakuten, TopCashback ...) come only from a rule that names the row a portal credit; they match open
 * `cashback_portal_recv` on orders dated up to 120 days before the credit. One order exact, else the oldest-first sum.
 */
export function suggestPortalCashback(txns: MatchTxn[], recvs: MatchRecv[]): CashbackSuggestion[] {
  const out: CashbackSuggestion[] = [];
  for (const t of txns) {
    if (t.amountCents <= 0) continue;
    const mine = recvs.filter(r => r.pcCents > 0 && dayDiff(r.orderDate, t.postedDate) >= 0 && dayDiff(r.orderDate, t.postedDate) <= PORTAL_LOOKBACK_DAYS)
      .sort((x, y) => x.orderId - y.orderId);
    const singles: CashbackOption[] = mine.filter(r => r.pcCents === t.amountCents).map(r => ({ units: [unit(r.orderId, 0, 0, r.pcCents)], aggregate: false }));
    if (singles.length > 0) { out.push({ txnId: t.id, portal: true, options: singles }); continue; }
    const agg = oldestFirstSum(mine.map(r => ({ ...unit(r.orderId, 0, 0, r.pcCents), date: r.orderDate })), t.amountCents);
    if (agg) out.push({ txnId: t.id, portal: true, options: [{ units: agg, aggregate: true }] });
  }
  return out;
}

// ---- Rule 8: user-made rules ----

export type MatchRuleIn = {
  id: number; bankAccountId: number | null; pattern: string; isRegex: boolean; sign: string; minCents: number | null; maxCents: number | null;
  action: string; enabled: boolean; costCategory?: string | null;
};
/** What a rule did to one row. `partnerId`: the other side of a transfer_to. */
export type RuleHit = { txnId: number; ruleId: number; action: string; partnerId?: number };

/** A regex that does not compile (or is absurdly long) never matches and never throws. */
export function ruleMatches(rule: MatchRuleIn, t: Pick<MatchTxn, 'accountId' | 'amountCents' | 'description'>): boolean {
  if (!rule.enabled || !rule.pattern) return false;
  if (rule.bankAccountId != null && rule.bankAccountId !== t.accountId) return false;
  if (rule.sign === 'debit' && t.amountCents >= 0) return false;
  if (rule.sign === 'credit' && t.amountCents <= 0) return false;
  const abs = Math.abs(t.amountCents);
  if (rule.minCents != null && abs < rule.minCents) return false;
  if (rule.maxCents != null && abs > rule.maxCents) return false;
  if (rule.isRegex) {
    if (rule.pattern.length > 200) return false;
    try { return new RegExp(rule.pattern, 'i').test(t.description); } catch { return false; }
  }
  return t.description.toLowerCase().includes(rule.pattern.toLowerCase());
}

/**
 * Run the rules over open rows nobody else claimed. The first enabled rule (lowest id) that matches a row wins, whether
 * or not it can act: an `ignore` rule does nothing on a mapped account, a `cost` rule needs a category and a debit on
 * a mapped account, `darkbloom` and `cashback_portal` need a credit, `transfer_to:<id>` needs an open opposite row of
 * the same amount on that account within TRANSFER_DAYS (else the row stays open). Rows are taken in id order.
 */
export function matchRules(txns: MatchTxn[], rules: MatchRuleIn[], mappedAccountIds: Set<number>): RuleHit[] {
  const sortedRules = [...rules].sort((a, b) => a.id - b.id);
  const rows = txns.filter(open).sort((a, b) => a.id - b.id);
  const used = new Set<number>();
  const hits: RuleHit[] = [];
  for (const t of rows) {
    if (used.has(t.id) || t.amountCents === 0) continue;
    const rule = sortedRules.find(r => ruleMatches(r, t));
    if (!rule) continue;
    const hit = { txnId: t.id, ruleId: rule.id, action: rule.action };
    const a = rule.action;
    if (a === 'personal') hits.push(hit);
    else if (a === 'ignore') { if (!mappedAccountIds.has(t.accountId)) hits.push(hit); }
    else if (a === 'cost') { if (rule.costCategory && t.amountCents < 0 && mappedAccountIds.has(t.accountId)) hits.push(hit); }
    else if (a === 'darkbloom' || a === 'cashback_portal') { if (t.amountCents > 0) hits.push(hit); }
    else if (a.startsWith('transfer_to:')) {
      const target = Number(a.slice('transfer_to:'.length));
      if (!Number.isInteger(target) || target === t.accountId) continue;
      const partner = rows
        .filter(p => p.id !== t.id && !used.has(p.id) && p.accountId === target && Math.sign(p.amountCents) === -Math.sign(t.amountCents) && Math.abs(p.amountCents) === Math.abs(t.amountCents)
          && Math.abs(dayDiff(t.postedDate, p.postedDate)) <= TRANSFER_DAYS)
        .sort((x, y) => Math.abs(dayDiff(t.postedDate, x.postedDate)) - Math.abs(dayDiff(t.postedDate, y.postedDate)) || x.id - y.id)[0];
      if (partner) { used.add(partner.id); hits.push({ ...hit, partnerId: partner.id }); }
    }
  }
  return hits;
}

// ---- Rule 4: deposits to payouts ----

/** A paid order that is waiting for its deposit. `openCents` = paid amount minus what payout / fee / returns links already cleared. */
export type MatchPayout = {
  orderId: number; buyerId: number | null; paidDay: string; paidCents: number; openCents: number;
  /** What the group actually paid for this order and is still open, when that is less than `openCents` (BFMR's amount_paid vs its total_payout). Subset searches use it. */
  payOpenCents?: number;
  /** The group reports it has paid this order (BG bgPaidAmount > 0, or BFMR amount_paid): its amounts are real, not expected. */
  groupPaid?: boolean;
  /** BuyingGroup only: the day its receipt for this order was paid out (Order.bgPayoutDay). Its deposit posts 0-3 days later. */
  payoutDay?: string | null;
};
/** The cents of an order a search should count: what the group actually paid when known, else its open amount. */
const searchCents = (p: MatchPayout): number => p.payOpenCents != null && p.payOpenCents > 0 ? Math.min(p.payOpenCents, p.openCents) : p.openCents;
export type DepositPart = { orderId: number; cents: number }; // cents of the deposit that go to this order
export type DepositOption = {
  how: 'single' | 'batch' | 'subset' | 'near' | 'payment' | 'bonus';
  buyerId: number | null;
  parts: DepositPart[];
  /** Open payout cents of the chosen orders; above the deposit means a shortfall. */
  totalCents: number;
  shortfallCents: number;
  /** The group payment this deposit was matched to ("bfmr:2026-07-09", "bg:<id>", ...), when one was. */
  payment?: string;
  /**
   * `how: 'bonus'` only: cents the deposit holds above the orders' own amounts (BuyingGroup's pre-scan bonus). The parts carry the
   * orders' full amounts; parts plus this bonus is the deposit. It links as `payout_bonus` and posts to Other income.
   */
  bonusCents?: number;
  /** `how: 'bonus'` only: found from the orders' receipt payout days (Order.bgPayoutDay), not their credit days. */
  byPayoutDay?: boolean;
};
/** `fromGroup`: the options come from a payment the group's own API reported (its orders, or what it paid), so an exact one links without a review. */
export type DepositSuggestion = { txnId: number; buyerId: number | null; aliased: boolean; fromGroup?: boolean; options: DepositOption[] };

/** A payment a buying group made (stored from its sync): total, day, buyer and the orders it paid with their cents. */
export type MatchGroupPayment = { id: number; group?: string; ref?: string; buyerId: number | null; buyerName: string | null; paidDay: string; amountCents: number; orders: DepositPart[] };
/** A deposit may land this many days after the group's payment day. */
export const GROUP_PAYMENT_DAYS = 7;
/** ... or this many days before it (payments stored by an older sync carry the received day, one after the send day the bank posts on). */
export const GROUP_PAYMENT_EARLY_DAYS = 1;

export const DEPOSIT_DAYS = 30;
export const DEPOSIT_MAX_ORDERS = 30;
export const DEPOSIT_NEAR_PCT = 3;
const DEPOSIT_MAX_OPTIONS = 4;

/**
 * Deposits through a channel that does not name the payer the same way each time, or that many payers share: Zelle,
 * PayPal, Venmo, Cash App, Apple Cash, checks (mobile, remote, branch, ATM, teller), cash, and transfers between accounts.
 * Their description never narrows a deposit to a buyer and is never learned. ACH and direct deposit names are.
 */
const GENERIC_PAYEE = /\b(?:ZELLE|PAYPAL|VENMO|CASH ?APP|SQUARE ?CASH|APPLE ?CASH|CHECK|CHK|CHEQUE|MOBILE ?DEP\w*|REMOTE ?DEP\w*|E-?DEPOSIT|ATM|BRANCH|TELLER|CASH DEP\w*|(?:ONLINE|INTERNAL|INSTANT|MOBILE) (?:BANKING )?TRANSFER|TRANSFER FROM|XFER FROM)\b/;
export function genericPayee(description: string): boolean {
  return GENERIC_PAYEE.test(description.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' '));
}

/** Description -> alias token: uppercase, dates and digits stripped, other punctuation to spaces, whitespace collapsed. */
export function payeeToken(description: string): string {
  const t = description.toUpperCase()
    .replace(/\b\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?\b/g, ' ')
    .replace(/[0-9]/g, ' ')
    .replace(/[^A-Z&' ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t.length >= 3 ? t : '';
}

/**
 * Split a deposit across the chosen orders. Each order gets at most its open amount. When the open total is more than the
 * deposit (a shortfall, or a piece of a bigger payout) the cash is shared pro rata; floor shares, the remainder goes to the
 * largest open orders without passing any order's open amount. null when the open total is less than the deposit.
 */
export function allocateDeposit(depositCents: number, picks: { orderId: number; openCents: number }[]): DepositPart[] | null {
  const total = picks.reduce((a, p) => a + p.openCents, 0);
  if (picks.length === 0 || depositCents <= 0 || total < depositCents) return null;
  if (total === depositCents) return picks.map(p => ({ orderId: p.orderId, cents: p.openCents }));
  const parts = picks.map(p => ({ orderId: p.orderId, cents: Math.floor(p.openCents * depositCents / total), open: p.openCents }));
  let rest = depositCents - parts.reduce((a, p) => a + p.cents, 0);
  for (const p of [...parts].sort((a, b) => b.open - a.open || a.orderId - b.orderId)) {
    if (rest <= 0) break;
    if (p.cents < p.open) { p.cents++; rest--; }
  }
  return parts.map(p => ({ orderId: p.orderId, cents: p.cents })).filter(p => p.cents > 0);
}

const optionOf = (how: DepositOption['how'], buyerId: number | null, orders: MatchPayout[], deposit: number, payment?: string): DepositOption => {
  const sorted = [...orders].sort((a, b) => a.orderId - b.orderId);
  const total = sorted.reduce((a, o) => a + o.openCents, 0);
  const parts = allocateDeposit(deposit, sorted.map(o => ({ orderId: o.orderId, openCents: searchCents(o) })))!;
  return { how, buyerId, parts, totalCents: total, shortfallCents: total - deposit, ...(payment ? { payment } : {}) };
};

/** BuyingGroup adds up to this many cents per item when tracking is submitted before the carrier's first scan. */
export const BONUS_MAX_CENTS_PER_ORDER = 5;
/** The buyer BuyingGroup deposits come from, by name. */
export const isBuyingGroupName = (name: string | null | undefined): boolean => !!name && /buying\s*group/i.test(name);
/** subsetSums stops looking after this many hits. */
export const SUBSET_HIT_CAP = 5000;

/** Meet in the middle: index subsets (size >= minSize) of `vals` whose sum is in [lo, hi]. Up to `limit`, smallest sums first. Stops entirely after SUBSET_HIT_CAP hits. */
export function subsetSums(vals: number[], lo: number, hi: number, minSize: number, limit: number): { idx: number[]; sum: number; key: string }[] {
  const n = vals.length;
  const h = n >> 1;
  const enumerate = (from: number, to: number) => {
    const out: { mask: number; sum: number }[] = [];
    const m = to - from;
    for (let mask = 0; mask < (1 << m); mask++) {
      let sum = 0;
      for (let i = 0; i < m; i++) if (mask & (1 << i)) sum += vals[from + i];
      out.push({ mask, sum });
    }
    return out;
  };
  const left = enumerate(0, h);
  const right = enumerate(h, n).sort((a, b) => a.sum - b.sum);
  const bits = (x: number) => { let c = 0; for (; x; x &= x - 1) c++; return c; };
  const hits: { idx: number[]; sum: number; key: string }[] = [];
  search: for (const l of left) {
    // first right sum >= lo - l.sum
    let a = 0, b = right.length;
    while (a < b) { const mid = (a + b) >> 1; if (right[mid].sum + l.sum < lo) a = mid + 1; else b = mid; }
    for (let k = a; k < right.length && right[k].sum + l.sum <= hi; k++) {
      if (bits(l.mask) + bits(right[k].mask) < minSize) continue;
      const idx: number[] = [];
      for (let i = 0; i < h; i++) if (l.mask & (1 << i)) idx.push(i);
      for (let i = 0; i < n - h; i++) if (right[k].mask & (1 << i)) idx.push(h + i);
      hits.push({ idx, sum: l.sum + right[k].sum, key: idx.join() });
      if (hits.length > SUBSET_HIT_CAP) break search;
    }
  }
  return hits.sort((a, b) => a.sum - b.sum || a.key.localeCompare(b.key)).slice(0, limit);
}


/** True when the deposit is from the payment's buyer: its payee name is that buyer's alias, or its text holds the buyer's name. */
function fromPaymentBuyer(g: MatchGroupPayment, alias: number | null, description: string): boolean {
  if (g.buyerId == null) return false;
  if (alias != null) return alias === g.buyerId;
  const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const name = g.buyerName ? norm(g.buyerName) : '';
  return name.length >= 3 && ` ${norm(description)} `.includes(` ${name} `);
}

/**
 * Rule 4 first step: a group payment whose total is exactly the deposit, paid 0-7 days before it, by this deposit's buyer, with
 * every order still open and its per-order cents adding up to the total. One option per such payment, exactly its orders (no
 * subset search). When the orders are owed more than the deposit (fees) the shortfall shows as with any deposit.
 */
function paymentOptions(t: MatchTxn, alias: number | null, groupPayments: MatchGroupPayment[], openBy: Map<number, MatchPayout>, allBy: Map<number, MatchPayout> = openBy): { opt: DepositOption; day: string; id: number }[] {
  const opts: { opt: DepositOption; day: string; id: number }[] = [];
  for (const g of groupPayments) {
    if (g.amountCents !== t.amountCents || g.orders.length === 0) continue;
    const gap = dayDiff(g.paidDay, t.postedDate);
    if (gap < -GROUP_PAYMENT_EARLY_DAYS || gap > GROUP_PAYMENT_DAYS || !fromPaymentBuyer(g, alias, t.description)) continue;
    if (g.orders.reduce((a, o) => a + o.cents, 0) !== g.amountCents) continue; // some of its orders are not known: not exact
    // A negative part is a fee clawed back from an order an earlier payment already paid: that order only has to be a paid order
    // (its open amount is spent), and the part passes through as it is. Every other order must be open.
    const pos = g.orders.filter(o => o.cents >= 0), neg = g.orders.filter(o => o.cents < 0);
    if (pos.length === 0 || neg.some(o => !allBy.has(o.orderId))) continue;
    const picks = pos.map(o => openBy.get(o.orderId));
    if (picks.some(p => !p || p.openCents <= 0)) continue;
    const orders = picks as MatchPayout[];
    const negCents = neg.reduce((a, o) => a + o.cents, 0);
    const capped = pos.map(o => ({ orderId: o.orderId, cents: Math.min(o.cents, openBy.get(o.orderId)!.openCents) }));
    const posParts = capped.reduce((a, p) => a + p.cents, 0) === g.amountCents - negCents ? capped
      : allocateDeposit(g.amountCents - negCents, [...orders].sort((a, b) => a.orderId - b.orderId).map(o => ({ orderId: o.orderId, openCents: o.openCents })));
    if (!posParts) continue;
    const parts = [...posParts, ...neg.map(o => ({ orderId: o.orderId, cents: o.cents }))].sort((a, b) => a.orderId - b.orderId);
    // what the orders are owed: open amounts of the positive orders less the fee clawed back; above the deposit means a shortfall
    const total = orders.reduce((a, o) => a + o.openCents, 0) + negCents;
    opts.push({ opt: { how: 'payment', buyerId: g.buyerId, parts, totalCents: total, shortfallCents: total - t.amountCents, ...(g.ref ? { payment: g.ref } : {}) }, day: g.paidDay, id: g.id });
  }
  return opts.sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id);
}

/** Closeness of a deposit to a payment day: gap = deposit day minus paid day. A deposit after the payment beats one before it, at the same distance. */
const gapScore = (gap: number) => 2 * Math.abs(gap) + (gap < 0 ? 1 : 0);

/**
 * One-to-one closest-date assignment. `cands`: deposit id -> its candidates (a payment or an order, by key) with the gap in days.
 * Pairs are taken by lowest score; a deposit and a candidate are each used once. A deposit whose best unused score is shared by
 * several candidates keeps all of them (it cannot tell them apart), and they are spent. `contested`: its one candidate is also the
 * best of another deposit at the same score, so neither can claim it. A deposit missing from the result has nothing left to say.
 */
export function assignClosest(cands: Map<number, { key: number; gap: number }[]>): Map<number, { keys: number[]; contested: boolean }> {
  const out = new Map<number, { keys: number[]; contested: boolean }>();
  const used = new Set<number>();
  const pairs: { dep: number; key: number; score: number }[] = [];
  for (const [dep, list] of cands) for (const c of list) pairs.push({ dep, key: c.key, score: gapScore(c.gap) });
  for (const score of [...new Set(pairs.map(p => p.score))].sort((a, b) => a - b)) {
    const at = pairs.filter(p => p.score === score && !out.has(p.dep) && !used.has(p.key));
    const byDep = new Map<number, Set<number>>(), byKey = new Map<number, Set<number>>();
    for (const p of at) {
      (byDep.get(p.dep) ?? byDep.set(p.dep, new Set()).get(p.dep)!).add(p.key);
      (byKey.get(p.key) ?? byKey.set(p.key, new Set()).get(p.key)!).add(p.dep);
    }
    for (const [dep, keys] of byDep) out.set(dep, { keys: [...keys].sort((a, b) => a - b), contested: keys.size === 1 && byKey.get([...keys][0])!.size > 1 });
    for (const k of byKey.keys()) used.add(k);
  }
  return out;
}

/**
 * The deposit is a stored group payment with no order list: look only at that buyer's orders the group has paid (groupPaid), by
 * the cents it actually paid, for one order or a subset of the last 30 days that adds up to the deposit exactly. One option or
 * several; no near misses. Empty when none fits (the ordinary search then runs).
 */
function searchLabeled(t: MatchTxn, g: MatchGroupPayment, open: MatchPayout[], bonusBuyer = false): DepositOption[] {
  const A = t.amountCents, label = g.ref ?? undefined;
  const pool = open.filter(p => p.buyerId === g.buyerId && p.groupPaid && p.paidDay <= t.postedDate);
  const single = pool.filter(p => searchCents(p) === A).sort((a, b) => a.orderId - b.orderId);
  if (single.length > 0) return single.map(p => optionOf('single', g.buyerId, [p], A, label));
  const recent = pool.filter(p => dayDiff(p.paidDay, t.postedDate) <= DEPOSIT_DAYS)
    .sort((a, b) => b.paidDay.localeCompare(a.paidDay) || b.orderId - a.orderId).slice(0, DEPOSIT_MAX_ORDERS)
    .sort((a, b) => a.orderId - b.orderId);
  if (recent.length === 0) return bonusBuyer ? receiptOptions(open.filter(p => p.buyerId === g.buyerId && p.groupPaid), t.postedDate, A, g.buyerId, label) : [];
  const subs = subsetSums(recent.map(p => searchCents(p)), A, A, 2, DEPOSIT_MAX_OPTIONS).map(h => optionOf('subset', g.buyerId, h.idx.map(i => recent[i]), A, label));
  if (subs.length > 0 || !bonusBuyer) return subs;
  const byDay = receiptOptions(open.filter(p => p.buyerId === g.buyerId && p.groupPaid), t.postedDate, A, g.buyerId, label);
  return byDay.length > 0 ? byDay : bonusOptions(recent, A, g.buyerId, label);
}

/** Days a BuyingGroup deposit posts after the day its receipts were paid out. */
export const RECEIPT_PAYOUT_DAYS = 3;
const payoutGap = (p: MatchPayout, postedDate: string): number | null => (p.payoutDay ? dayDiff(p.payoutDay, postedDate) : null);

/**
 * BuyingGroup pays per receipt: a deposit is the orders' amounts paid out the same day plus 5 cents per receipt. Candidates are the
 * orders whose receipt was paid out 0-3 days before the deposit (Order.bgPayoutDay); the set whose open amounts plus 5 cents each
 * make the deposit. A bonus of 1-4 cents an order is a fallback when no set carries the full 5 (receipts shared by several orders).
 */
function receiptOptions(list: MatchPayout[], postedDate: string, A: number, buyerId: number | null, payment?: string): DepositOption[] {
  const recent = list.filter(p => { const g = payoutGap(p, postedDate); return g != null && g >= 0 && g <= RECEIPT_PAYOUT_DAYS; })
    .sort((a, b) => (b.payoutDay ?? '').localeCompare(a.payoutDay ?? '') || b.orderId - a.orderId).slice(0, DEPOSIT_MAX_ORDERS)
    .sort((a, b) => a.orderId - b.orderId);
  if (recent.length === 0) return [];
  const hits = subsetSums(recent.map(p => searchCents(p)), A - BONUS_MAX_CENTS_PER_ORDER * recent.length, A - 1, 1, SUBSET_HIT_CAP + 1)
    .map(h => ({ h, b: A - h.sum }))
    .filter(x => x.b >= 1 && x.b <= BONUS_MAX_CENTS_PER_ORDER * x.h.idx.length);
  const full = hits.filter(x => x.b === BONUS_MAX_CENTS_PER_ORDER * x.h.idx.length);
  return (full.length > 0 ? full : hits)
    .sort((x, y) => x.h.idx.length - y.h.idx.length || x.b - y.b || x.h.key.localeCompare(y.h.key))
    .slice(0, DEPOSIT_MAX_OPTIONS)
    .map(x => {
      const orders = x.h.idx.map(i => recent[i]).sort((a, b) => a.orderId - b.orderId);
      return { how: 'bonus', buyerId, parts: orders.map(o => ({ orderId: o.orderId, cents: searchCents(o) })), totalCents: x.h.sum, shortfallCents: 0, bonusCents: x.b, byPayoutDay: true, ...(payment ? { payment } : {}) } satisfies DepositOption;
    });
}

/**
 * BuyingGroup's pre-scan bonus: the deposit is the orders' amounts plus a few cents (at most 5 per order). Subsets of `recent` whose
 * sum is A - b, 1 <= b <= 5 x orders, each order exact (no shortfall). Smallest bonus first, then fewest orders.
 */
function bonusOptions(recent: MatchPayout[], A: number, buyerId: number | null, payment?: string): DepositOption[] {
  const vals = recent.map(p => searchCents(p));
  return subsetSums(vals, A - BONUS_MAX_CENTS_PER_ORDER * recent.length, A - 1, 1, SUBSET_HIT_CAP + 1)
    .map(h => ({ h, b: A - h.sum }))
    .filter(x => x.b >= 1 && x.b <= BONUS_MAX_CENTS_PER_ORDER * x.h.idx.length)
    .sort((x, y) => x.b - y.b || x.h.idx.length - y.h.idx.length || x.h.key.localeCompare(y.h.key))
    .slice(0, DEPOSIT_MAX_OPTIONS)
    .map(x => {
      const orders = x.h.idx.map(i => recent[i]).sort((a, b) => a.orderId - b.orderId);
      return { how: 'bonus', buyerId, parts: orders.map(o => ({ orderId: o.orderId, cents: searchCents(o) })), totalCents: x.h.sum, shortfallCents: 0, bonusCents: x.b, ...(payment ? { payment } : {}) } satisfies DepositOption;
    });
}

/** A stored payment with no order list (BG) that is exactly this deposit: same cents, 0-7 days after, from its buyer. */
function labeledPayment(t: MatchTxn, alias: number | null, groupPayments: MatchGroupPayment[]): MatchGroupPayment | null {
  const hits = groupPayments.filter(g => g.orders.length === 0 && g.amountCents === t.amountCents && g.buyerId != null
    && dayDiff(g.paidDay, t.postedDate) >= -GROUP_PAYMENT_EARLY_DAYS && dayDiff(g.paidDay, t.postedDate) <= GROUP_PAYMENT_DAYS && fromPaymentBuyer(g, alias, t.description));
  return hits.sort((a, b) => a.paidDay.localeCompare(b.paidDay) || a.id - b.id)[0] ?? null;
}

/**
 * Credits on a bank account that holds payouts (`depositAccountIds`) to open payouts, in this order, stopping at the first
 * step that finds something: a group's own payment of exactly this amount (see paymentOptions; 1 day early to 7 days late); one order exact (any age); all of one buyer's orders paid the same day, exact; a subset of
 * one buyer's orders paid in the 30 days before the deposit, exact (the 30 most recent orders at most); else a subset 0-3%
 * above the deposit (a near miss: the shortfall must be classified, so it is never auto; only for a payee tied to a buyer,
 * since across every buyer a near sum is a guess). `aliases` is token -> buyer id: a
 * known ACH payee narrows the search to that buyer's orders (never a generic channel, see genericPayee). Several options
 * means the user picks.
 */
export function suggestDeposits(
  txns: MatchTxn[], depositAccountIds: Set<number>, payouts: MatchPayout[], aliases: Map<string, number>, groupPayments: MatchGroupPayment[] = [],
  /** Buyers that pay BuyingGroup's pre-scan bonus (see bonusOptions). */
  bonusBuyerIds: Set<number> = new Set(),
): DepositSuggestion[] {
  const out: DepositSuggestion[] = [];
  // Kept for the one-to-one pass after the loop: the group payments each deposit could be (4-0), and the identical single orders (4a).
  const payCands = new Map<number, { s: DepositSuggestion; cands: { opt: DepositOption; day: string; id: number }[] }>();
  const singleCands = new Map<number, { s: DepositSuggestion; gaps: Map<number, number> }>();
  const openPayouts = payouts.filter(p => p.openCents > 0);
  const openBy = new Map(openPayouts.map(p => [p.orderId, p]));
  const allBy = new Map(payouts.map(p => [p.orderId, p]));
  for (const t of txns) {
    if (!open(t) || t.amountCents <= 0 || !depositAccountIds.has(t.accountId)) continue;
    const tok = genericPayee(t.description) ? '' : payeeToken(t.description);
    const alias = tok ? aliases.get(tok) ?? null : null;
    // a stored payment with no order list (BG): the deposit is labeled as it, and only orders the group has paid are searched, by what it paid
    const label = labeledPayment(t, alias, groupPayments);
    const labeled = label != null ? searchLabeled(t, label, openPayouts, label.group === 'bg' || (label.buyerId != null && bonusBuyerIds.has(label.buyerId))) : [];
    if (labeled.length > 0) { out.push({ txnId: t.id, buyerId: label!.buyerId, aliased: true, fromGroup: true, options: labeled.slice(0, DEPOSIT_MAX_OPTIONS) }); continue; }
    const pool = alias != null ? openPayouts.filter(p => p.buyerId === alias) : openPayouts;
    const A = t.amountCents;
    const done = (options: DepositOption[]) => { const s: DepositSuggestion = { txnId: t.id, buyerId: alias, aliased: alias != null, options: options.slice(0, DEPOSIT_MAX_OPTIONS) }; out.push(s); return s; };
    // 4-0. a group's payment of exactly this amount: its own orders, no guessing
    const paid = paymentOptions(t, alias, groupPayments, openBy, allBy);
    if (paid.length > 0) {
      const s: DepositSuggestion = { txnId: t.id, buyerId: paid[0].opt.buyerId, aliased: true, fromGroup: true, options: paid.slice(0, DEPOSIT_MAX_OPTIONS).map(c => c.opt) };
      out.push(s);
      payCands.set(t.id, { s, cands: paid });
      continue;
    }
    // 4a. one order, exact. Identical amounts are told apart below, by the day the group really paid each (see assignClosest).
    const single = pool.filter(p => searchCents(p) === A).sort((a, b) => a.orderId - b.orderId);
    if (single.length > 0) {
      const s = done(single.map(p => optionOf('single', p.buyerId, [p], A)));
      if (single.length > 1) singleCands.set(t.id, { s, gaps: new Map(single.filter(p => p.groupPaid).map(p => [p.orderId, dayDiff(p.paidDay, t.postedDate)] as const).filter(([, g]) => g >= -GROUP_PAYMENT_EARLY_DAYS && g <= DEPOSIT_DAYS)) });
      continue;
    }
    const byBuyer = new Map<number, MatchPayout[]>();
    for (const p of pool) if (p.buyerId != null && p.paidDay <= t.postedDate) (byBuyer.get(p.buyerId) ?? byBuyer.set(p.buyerId, []).get(p.buyerId)!).push(p);
    // 4b. all of one buyer's orders paid the same day
    const batches: DepositOption[] = [];
    for (const [buyerId, list] of [...byBuyer].sort((a, b) => a[0] - b[0])) {
      const days = new Map<string, MatchPayout[]>();
      for (const p of list) (days.get(p.paidDay) ?? days.set(p.paidDay, []).get(p.paidDay)!).push(p);
      for (const [, g] of [...days].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (g.length >= 2 && g.reduce((a, p) => a + searchCents(p), 0) === A) batches.push(optionOf('batch', buyerId, g, A));
      }
    }
    if (batches.length > 0) { done(batches); continue; }
    // 4c. a subset of one buyer's orders paid in the 30 days before; 4d. near miss
    const hi = Math.floor(A * (100 + DEPOSIT_NEAR_PCT) / 100);
    const subsets: DepositOption[] = [];
    const near: { opt: DepositOption; sum: number }[] = [];
    for (const [buyerId, list] of [...byBuyer].sort((a, b) => a[0] - b[0])) {
      const recent = list.filter(p => dayDiff(p.paidDay, t.postedDate) <= DEPOSIT_DAYS)
        .sort((a, b) => b.paidDay.localeCompare(a.paidDay) || b.orderId - a.orderId).slice(0, DEPOSIT_MAX_ORDERS)
        .sort((a, b) => a.orderId - b.orderId);
      if (recent.length === 0) continue;
      const vals = recent.map(p => searchCents(p));
      for (const h of subsetSums(vals, A, A, 2, DEPOSIT_MAX_OPTIONS)) subsets.push(optionOf('subset', buyerId, h.idx.map(i => recent[i]), A));
      if (alias != null && A < hi) for (const h of subsetSums(vals, A + 1, hi, 1, 3)) near.push({ opt: optionOf('near', buyerId, h.idx.map(i => recent[i]), A), sum: h.sum });
    }
    if (subsets.length > 0) { done(subsets); continue; }
    // 4c'. BuyingGroup's pre-scan bonus: the orders plus a few cents. After the exact searches, before the near misses.
    if (alias != null && bonusBuyerIds.has(alias)) {
      const list = byBuyer.get(alias) ?? [];
      const byDay = receiptOptions(pool.filter(p => p.buyerId === alias), t.postedDate, A, alias);
      if (byDay.length > 0) { done(byDay); continue; }
      const recent = list.filter(p => dayDiff(p.paidDay, t.postedDate) <= DEPOSIT_DAYS)
        .sort((a, b) => b.paidDay.localeCompare(a.paidDay) || b.orderId - a.orderId).slice(0, DEPOSIT_MAX_ORDERS)
        .sort((a, b) => a.orderId - b.orderId);
      const bonus = bonusOptions(recent, A, alias);
      if (bonus.length > 0) { done(bonus); continue; }
    }
    if (near.length > 0) done(near.sort((a, b) => a.sum - b.sum).map(n => n.opt).slice(0, 3));
  }
  // One-to-one across the open deposits: a payment (or an order) is for one deposit, the closest in date.
  const byTxn = new Map(txns.map(t => [t.id, t]));
  const payAssign = assignClosest(new Map([...payCands].map(([id, c]) => [id, c.cands.map(x => ({ key: x.id, gap: dayDiff(x.day, byTxn.get(id)!.postedDate) }))])));
  for (const [id, { s, cands }] of payCands) {
    const a = payAssign.get(id);
    if (!a) continue;
    s.options = cands.filter(c => a.keys.includes(c.id)).map(c => c.opt);
    if (a.contested) delete s.fromGroup; // two deposits and one payment: neither can claim it
  }
  const singleAssign = assignClosest(new Map([...singleCands].map(([id, c]) => [id, [...c.gaps].map(([key, gap]) => ({ key, gap }))])));
  for (const [id, { s }] of singleCands) {
    const a = singleAssign.get(id);
    if (!a) continue;
    s.options = s.options.filter(o => a.keys.includes(o.parts[0].orderId));
  }
  return out;
}

/** An option the user need not look at: a known payee, exactly one option, exact, and not a near miss. */
export function depositAutoOption(s: Extract<Suggestion, { kind: 'deposit' }>): DepositOption | null {
  if (!s.aliased || s.options.length !== 1) return null;
  const o = s.options[0];
  if (o.how === 'payment') return o; // the group's own payment: any fee shows as a shortfall to classify
  return o.how !== 'near' && o.shortfallCents === 0 ? o : null;
}

/** Days a certain deposit may land after the day the group paid its orders (and 1 before, for payments stored with the received day). */
export const CERTAIN_DEPOSIT_DAYS = 30;

/**
 * An option that needs neither autoMatch nor a group payment record: a known payee, exactly one option, exact (a payment, one
 * order, a batch, a subset or a BuyingGroup bonus; never a near miss, never a shortfall), every order paid by the group itself
 * (`groupPaid`, a real paid day) 0-30 days before the deposit, and none of its orders in another open deposit's options (`contended`).
 */
export function certainDepositOption(
  s: Extract<Suggestion, { kind: 'deposit' }>, postedDate: string, payouts: Map<number, MatchPayout>, contended: (orderId: number) => boolean,
): DepositOption | null {
  if (!s.aliased || s.options.length !== 1) return null;
  const o = s.options[0];
  if (o.how === 'near' || o.shortfallCents !== 0 || o.parts.length === 0) return null;
  for (const p of o.parts) {
    const m = payouts.get(p.orderId);
    if (!m || m.groupPaid !== true || contended(p.orderId)) return null;
    if (o.byPayoutDay) {
      const g = payoutGap(m, postedDate);
      if (g == null || g < 0 || g > RECEIPT_PAYOUT_DAYS) return null;
      continue;
    }
    const gap = dayDiff(m.paidDay, postedDate);
    if (gap < -GROUP_PAYMENT_EARLY_DAYS || gap > CERTAIN_DEPOSIT_DAYS) return null;
  }
  return o;
}

// ---- all rules, in order ----

export type Suggestion =
  | { kind: 'transfer'; txnId: number }
  | { kind: 'order'; orderIds: number[] }
  /** Several charges for one order. `subsets` are alternatives (more than one means the user picks). `amounts`: txnId -> cents. */
  | { kind: 'split'; orderId: number; subsets: number[][]; amounts: Record<number, number> }
  /** A refund; `partial` when the credit is only part of what is left of that return's refund. */
  | { kind: 'refund'; returns: { returnId: number; orderId: number; partial: boolean }[] }
  /** A charge and the refund of it on the same card (the other row). */
  | { kind: 'pair'; txnId: number }
  /** A credit that clears cashback receivables: several options means the user picks one. */
  | { kind: 'cashback'; portal: boolean; options: CashbackOption[] }
  /** A credit that clears undeposited payouts. `aliased`: the payee is a known buyer (needed to auto-accept). */
  | { kind: 'deposit'; buyerId: number | null; aliased: boolean; fromGroup?: boolean; options: DepositOption[] };

export type MatchExtras = {
  returns?: MatchReturn[]; takenReturnIds?: Set<number>; recvs?: MatchRecv[];
  /** Deposits: ids of bank accounts that can hold payouts, open payouts, and payee aliases (token -> buyer id). */
  depositAccountIds?: Set<number>; payouts?: MatchPayout[]; aliases?: Map<string, number>; groupPayments?: MatchGroupPayment[];
  /** Buyers whose deposits can carry BuyingGroup's pre-scan bonus. */
  bonusBuyerIds?: Set<number>;
};

/**
 * Run the rules in order; a transaction claimed by one rule is not offered to the next. Returns txnId -> suggestion.
 * (Deposits come after these; user rules run on what is left, see matchRules.)
 */
export function suggestAll(
  txns: MatchTxn[], accounts: MatchAccount[], orders: MatchOrder[], cardLastFours: CardLastFours,
  takenOrderIds: Set<number> = new Set(), extras: MatchExtras = {},
): Map<number, Suggestion> {
  const out = new Map<number, Suggestion>();
  const left = () => txns.filter(t => !out.has(t.id));
  // 1. transfers
  for (const p of suggestTransfers(txns, accounts)) {
    out.set(p.aId, { kind: 'transfer', txnId: p.bId });
    out.set(p.bId, { kind: 'transfer', txnId: p.aId });
  }
  // 2a. charge -> order, 1:1
  for (const s of suggestCharges(left(), accounts, orders, cardLastFours, takenOrderIds)) {
    out.set(s.txnId, { kind: 'order', orderIds: s.candidates.map(c => c.orderId) });
  }
  const suggestedOrders = new Set<number>();
  for (const s of out.values()) if (s.kind === 'order') for (const id of s.orderIds) suggestedOrders.add(id);
  // 2b. split shipments (an order already offered a 1:1 charge is left to that)
  const byId = new Map(txns.map(t => [t.id, t]));
  const noSplit = new Set([...takenOrderIds, ...suggestedOrders]);
  for (const s of suggestSplits(left(), accounts, orders, cardLastFours, noSplit)) {
    const amounts: Record<number, number> = {};
    for (const sub of s.subsets) for (const id of sub) amounts[id] = -byId.get(id)!.amountCents;
    for (const sub of s.subsets) for (const id of sub) {
      const prev = out.get(id);
      if (!prev) out.set(id, { kind: 'split', orderId: s.orderId, subsets: s.subsets, amounts });
    }
  }
  // 3a. refunds to returns
  for (const s of suggestRefunds(left(), accounts, extras.returns ?? [], cardLastFours, extras.takenReturnIds)) {
    out.set(s.txnId, { kind: 'refund', returns: s.candidates });
  }
  // 3b. charge-and-refund pairs
  for (const p of suggestPairs(left(), accounts)) {
    out.set(p.chargeId, { kind: 'pair', txnId: p.refundId });
    out.set(p.refundId, { kind: 'pair', txnId: p.chargeId });
  }
  // 4. deposits to payouts
  if (extras.depositAccountIds && extras.payouts) {
    for (const d of suggestDeposits(left(), extras.depositAccountIds, extras.payouts, extras.aliases ?? new Map(), extras.groupPayments ?? [], extras.bonusBuyerIds)) {
      out.set(d.txnId, { kind: 'deposit', buyerId: d.buyerId, aliased: d.aliased, ...(d.fromGroup ? { fromGroup: true } : {}), options: d.options });
    }
  }
  // 5. cashback credits on a card
  for (const c of suggestCashbackCredits(left(), accounts, extras.recvs ?? [], cardLastFours)) {
    out.set(c.txnId, { kind: 'cashback', portal: false, options: c.options });
  }
  return out;
}
