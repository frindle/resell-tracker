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
// Later rules (deposits to payouts) slot in after these in suggestAll.

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
    found.sort((x, y) => Number(y.exact) - Number(x.exact) || x.orderId - y.orderId);
    out.push({ txnId: t.id, candidates: found.map(f => ({ orderId: f.orderId, exact: f.exact })) });
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
 * Amazon, Walmart and Best Buy charge per shipment: several charges on the order's card, 0-7 days after the order
 * date, that add up to what is still to be charged for the order (exact, or inside the tax window). More than 8 candidate
 * charges: no search, the row stays in the inbox. Two different subsets that both fit are both reported, so the caller
 * keeps the rows 'suggested' and the user picks. `claimedTxnIds` (rows an earlier rule took) are not offered.
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
      return inChargeWindow(o, t);
    });
    if (cand.length < 2 || cand.length > SPLIT_MAX_CHARGES) continue;
    const e = remainingChargeCents(o);
    // A subset must be on one card account (the candidates already are on this order's card; accounts may differ by last4).
    const subs = subsetsInRange(cand, t => -t.amountCents, e.min, e.max, 2)
      .filter(sub => new Set(sub.map(t => t.accountId)).size === 1);
    if (subs.length === 0) continue;
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

/** A short key for who a row is from: a known retailer's name, else the first letter-word of the description. */
export function merchantKey(description: string): string {
  for (const [k, re] of Object.entries(RETAILER_WORDS)) if (re.test(description)) return k;
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
  | { kind: 'cashback'; portal: boolean; options: CashbackOption[] };

export type MatchExtras = { returns?: MatchReturn[]; takenReturnIds?: Set<number>; recvs?: MatchRecv[] };

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
  for (const p of suggestTransfers(txns)) {
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
  // 5. cashback credits on a card
  for (const c of suggestCashbackCredits(left(), accounts, extras.recvs ?? [], cardLastFours)) {
    out.set(c.txnId, { kind: 'cashback', portal: false, options: c.options });
  }
  return out;
}
