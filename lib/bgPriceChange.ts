// BuyingGroup "Commitment Price Change Scheduled" notices, and what a
// commitment price change does to the orders linked to it. Pure: the email
// side (lib/emailAutoImport.ts) and the commitment sync
// (app/api/buyinggroup/sync-commitments) share this, the database work is in
// lib/commitmentReprice.ts.
//
// The notice reads, in its text part (which BuyingGroup fills with HTML):
//   Price change scheduled on: CM-1234567890,
//   New price will be: 599.00
//   New comission will be: 2.00          ← their spelling
//   On Nov. 23, 2026, 4 a.m..
import { orderPnl, type OrderMoney } from './orderPnl.ts';

export type PriceTerms = { price: number; commission: number };

export type BgPriceChange = {
  commitmentId: string;
  price: number;
  /** null when the notice gives no commission: the commitment keeps its own. */
  commission: number | null;
  /** BuyingGroup's own wording of when, for messages ("Nov. 23, 2026, 4 a.m."). */
  when: string;
  /**
   * The same moment as an ISO string, read as UTC because the notice names no
   * zone. UTC is the earliest any US reading could mean, so a check timed by it
   * is never late. null when the notice gives no date.
   */
  effectiveAt: string | null;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = String.raw`\$?\s*([\d,]+(?:\.\d+)?)`;

function plain(body: string): string {
  return String(body ?? '')
    .replace(/<(script|style|head)(?=[\s>])[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\r\f\v]+/g, ' ');
}

const money = (s: string) => {
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "Nov. 23, 2026" plus an optional "4 a.m." / "4:30 p.m." / "noon" / "midnight", as UTC. */
export function parseBgWhen(text: string): string | null {
  const m = String(text ?? '').match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})(?:,?\s*(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?))?/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  let hour = 0;
  let minute = 0;
  if (m[4]?.toLowerCase() === 'noon') hour = 12;
  else if (m[5]) {
    hour = Number(m[5]) % 12 + (m[7].toLowerCase() === 'p' ? 12 : 0);
    minute = m[6] ? Number(m[6]) : 0;
  }
  const t = Date.UTC(Number(m[3]), month, Number(m[2]), hour, minute);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseBgPriceChange(subject: string, body: string): BgPriceChange | null {
  if (!/commitment price change/i.test(String(subject ?? ''))) return null;
  const text = plain(body);
  const id = text.match(/price change scheduled on:?\s*(CM-[A-Za-z0-9-]+?)(?=[\s,.;]|$)/i);
  const price = text.match(new RegExp(String.raw`new price will be:?\s*${NUM}`, 'i'));
  if (!id || !price) return null;
  const p = money(price[1]);
  if (p == null) return null;
  const comm = text.match(new RegExp(String.raw`new comm?iss?ion will be:?\s*${NUM}`, 'i'));
  const c = comm ? money(comm[1]) : null;
  const on = text.match(/\bOn\s+([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4}(?:,\s*(?:noon|midnight|\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?))?)/i);
  const when = on ? on[1].replace(/\.+$/, '.').trim() : '';
  return { commitmentId: id[1], price: p, commission: c, when, effectiveAt: on ? parseBgWhen(on[1]) : null };
}

export const unitPrice = (t: PriceTerms) => t.price + t.commission;

export function sameTerms(a: PriceTerms, b: PriceTerms): boolean {
  return Math.abs(a.price - b.price) < 0.005 && Math.abs(a.commission - b.commission) < 0.005;
}

/**
 * A commitment row's price and commission as numbers; null when either is missing or not a finite number. The sync must not
 * read that as 0: a zero commission looks like a price change and would reprice linked orders to the price alone.
 */
export function parseCommitmentTerms(price: unknown, commission: unknown): PriceTerms | null {
  const p = parseFloat(String(price ?? '').replace(/,/g, '')), c = parseFloat(String(commission ?? '').replace(/,/g, ''));
  return Number.isFinite(p) && Number.isFinite(c) ? { price: p, commission: c } : null;
}

/**
 * When a commitment became full (every unit in), stamped by the sync that sees it go from not full to full, also when
 * the count dropped to what was already fulfilled. A commitment first seen full has no date (when it filled is unknown).
 */
export function commitmentFulfilledAt(
  prev: { count: number; fulfilled: number; fulfilledAt: Date | null } | undefined,
  now: { count: number; fulfilled: number },
  at: Date,
): Date | null {
  if (!(now.count > 0 && now.fulfilled >= now.count)) return null;
  if (prev?.fulfilledAt) return prev.fulfilledAt;
  const wasFull = prev != null && prev.count > 0 && prev.fulfilled >= prev.count;
  return prev && !wasFull ? at : null;
}

/** The terms a notice sets, keeping the commitment's commission when the notice gives none. */
export function termsAfter(change: Pick<BgPriceChange, 'price' | 'commission'>, current: PriceTerms): PriceTerms {
  return { price: change.price, commission: change.commission ?? current.commission };
}

export type RepriceOrder = OrderMoney & {
  id: number;
  locked: boolean;
  cancelled: boolean;
  salePriceSynced: boolean;
  bgCredited: boolean;
  bgPaidAmount: number | null;
};

export type RepriceSkip = 'cancelled' | 'paid' | 'locked';

/**
 * Why an order's sale price stays put when its commitment's price changes, or
 * null when it follows the commitment. Once BuyingGroup has paid or credited
 * the order, salePrice is what they paid and a later price is not.
 */
export function repriceSkip(o: Pick<RepriceOrder, 'locked' | 'cancelled' | 'salePriceSynced' | 'bgCredited' | 'bgPaidAmount'>): RepriceSkip | null {
  if (o.cancelled) return 'cancelled';
  if (o.salePriceSynced || o.bgCredited || (o.bgPaidAmount ?? 0) > 0) return 'paid';
  if (o.locked) return 'locked';
  return null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * How far the sale price is under what the order cost (cost + shipping +
 * insurance, less returned units), or 0 when it isn't. Cashback is left out:
 * it is a reason to sell under cost, not part of the cost.
 */
export function belowCostBy(o: OrderMoney): number {
  if (o.salePrice == null) return 0;
  const { sale, cost } = orderPnl(o);
  const gap = cents(cost - sale);
  return gap > 0.005 ? gap : 0;
}

/** The sale price an order will have once its commitment's unit price moves, for a heads-up before it does. */
export function previewSale(salePrice: number | null, soldQty: number, from: PriceTerms, to: PriceTerms): number | null {
  if (salePrice == null) return null;
  return cents(salePrice + (unitPrice(to) - unitPrice(from)) * soldQty);
}

export type RepriceResult = {
  orderId: number;
  skip: RepriceSkip | null;
  oldSale: number | null;
  newSale: number | null;
  /** How far under cost the new sale price is, 0 when it isn't. */
  under: number;
  /** Cashback and other credits on the order, to say whether it still makes money. */
  credits: number;
};

/** What a re-price does to an order's below-cost flag: set it, clear it, or leave it. */
export function alertChange(r: Pick<RepriceResult, 'oldSale' | 'newSale' | 'under'>, hasAlert: boolean): 'set' | 'clear' | 'keep' {
  if (r.newSale == null) return 'keep';
  if (r.under > 0) return r.oldSale == null || r.newSale < r.oldSale - 0.005 ? 'set' : 'keep';
  return hasAlert ? 'clear' : 'keep';
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const termsText = (t: PriceTerms) => `${usd(t.price)} + ${usd(t.commission)}`;

/** The order's below-cost flag text. */
export function alertText(commitmentId: string, day: string, r: RepriceResult): string {
  return `BuyingGroup price change ${day} on ${commitmentId}: sale ${usd(r.oldSale ?? 0)} → ${usd(r.newSale ?? 0)}, ${usd(r.under)} under cost`;
}

/** A dated line for the order's notes. The same change never adds it twice. */
export function priceNoteLine(commitmentId: string, day: string, to: PriceTerms, r: RepriceResult): string {
  return `BG price ${day}: ${commitmentId} now ${termsText(to)}/unit, sale ${usd(r.oldSale ?? 0)} → ${usd(r.newSale ?? 0)}`;
}

function orderLine(r: RepriceResult): string {
  if (r.skip === 'cancelled') return `  #${r.orderId}: cancelled, left alone`;
  if (r.skip) return `  #${r.orderId}: ${r.skip === 'paid' ? 'already paid' : 'locked'}, sale stays ${r.oldSale == null ? 'unset' : usd(r.oldSale)}`;
  const move = r.oldSale != null && r.newSale != null && Math.abs(r.newSale - r.oldSale) > 0.005
    ? `sale ${usd(r.oldSale)} → ${usd(r.newSale)}`
    : `sale ${r.newSale == null ? 'unset' : usd(r.newSale)} (no change)`;
  if (r.under <= 0) return `  #${r.orderId}: ${move}`;
  const net = r.credits > 0
    ? (r.credits >= r.under ? `, still ${usd(r.credits - r.under)} ahead with cashback` : `, ${usd(r.under - r.credits)} short even with cashback`)
    : '';
  return `  #${r.orderId}: ${move} ⚠ ${usd(r.under)} BELOW COST${net}`;
}

/**
 * Pushover text for a price change. `scheduled` is the heads-up when the
 * notice arrives before BuyingGroup has moved the price; the order lines are
 * then what will happen, not what did. Tracker order ids only.
 */
export function priceChangeText(
  commitmentId: string,
  from: PriceTerms | null,
  to: PriceTerms,
  when: string,
  results: readonly RepriceResult[],
  scheduled: boolean,
): string {
  const terms = from && !sameTerms(from, to) ? `${termsText(from)} → ${termsText(to)}` : `now ${termsText(to)}`;
  const head = scheduled
    ? `BuyingGroup scheduled a price change on ${commitmentId}${when ? ` for ${when}` : ''}: ${terms} per unit. When it applies:`
    : `BuyingGroup price change on ${commitmentId}${when ? ` (${when})` : ''}: ${terms} per unit.`;
  const lines = results.length ? results.map(orderLine) : ['  No orders linked to it.'];
  return [head, ...lines].join('\n');
}

/** Whether any order in a re-price went under cost, for the Pushover priority and title. */
export const anyUnderCost = (results: readonly RepriceResult[]) => results.some(r => r.under > 0 && !r.skip);
