// Decides which order an uploaded photo (gift card or receipt) belongs to,
// from what OCR read off it. Pure, no I/O: the caller loads the orders and
// cards and stores the result.
//
// Strength:
//   exact     - an identifier read off the photo equals one stored on exactly
//               one order (a gift card number, or an order/transaction number).
//               Safe to attach without asking.
//   likely    - receipt amount + date (+ card last 4 when the receipt shows one)
//               narrow to a single order. Shown as a suggestion, never applied
//               on its own.
//   ambiguous - several orders fit equally; they're listed for a person to pick.
//   none      - nothing to go on.
//
// No fuzzy matching on identifiers, the same rule as lib/giftCardOcrVerify.ts:
// a near-miss on a card number is a different card.
import { extractOrderNumbers } from './orderNumberExtract.ts';
import { parseReceipt, type ParsedReceipt } from './receiptParse.ts';

export type MatchOrder = {
  id: number;
  orderNumber: string | null;
  /** ISO string or Date */
  orderDate: string | Date;
  cost: number;
  shippingCost: number;
  /** Every last 4 of the order's card (primary + authorized users). Empty when no card is set. */
  cardLast4s: string[];
};

export type MatchGiftCard = { id: number; orderId: number; cardNumber: string };

export type PhotoKind = 'gift_card' | 'receipt' | 'unknown';

export type PhotoMatch = {
  kind: PhotoKind;
  strength: 'exact' | 'likely' | 'ambiguous' | 'none';
  orderId: number | null;
  giftCardId: number | null;
  /** Other orders that fit, for 'ambiguous' (and 'likely' runners-up). */
  alternatives: number[];
  reason: string;
  receipt: ParsedReceipt;
};

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const DAY = 86_400_000;

function dayNumber(d: string | Date): number {
  const s = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY);
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

// Receipt totals include tax and Order.cost never does, so a total matches
// when it sits between the pre-tax amount and that amount plus up to 11% tax.
function totalFits(total: number, o: MatchOrder): boolean {
  for (const base of [o.cost, o.cost + o.shippingCost]) {
    if (near(total, base)) return true;
    if (total > base && total <= base * 1.11 + o.shippingCost + 0.011) return true;
  }
  return false;
}

function subtotalFits(sub: number, o: MatchOrder): boolean {
  return near(sub, o.cost) || near(sub, o.cost + o.shippingCost);
}

export function matchPhoto(
  input: { texts: string[]; candidates: string[]; looksLikeReceipt: boolean; capturedAt?: string | Date | null },
  orders: MatchOrder[],
  giftCards: MatchGiftCard[],
): PhotoMatch {
  const receipt = parseReceipt(input.texts);
  const base = { giftCardId: null as number | null, alternatives: [] as number[], receipt };
  const kind: PhotoKind = input.looksLikeReceipt ? 'receipt' : input.candidates.length ? 'gift_card' : 'unknown';

  // 1. Gift card number on file.
  const reads = new Set(input.candidates.map(norm).filter(c => c.length >= 8));
  const cardHits = giftCards.filter(g => reads.has(norm(g.cardNumber)));
  const cardOrders = [...new Set(cardHits.map(g => g.orderId))];
  if (cardOrders.length === 1) {
    return {
      ...base, kind: 'gift_card', strength: 'exact', orderId: cardOrders[0],
      giftCardId: cardHits.length === 1 ? cardHits[0].id : null,
      reason: 'Card number matches a gift card on this order',
    };
  }
  if (cardOrders.length > 1) {
    return { ...base, kind: 'gift_card', strength: 'ambiguous', orderId: null, alternatives: cardOrders, reason: 'Card number is on more than one order' };
  }

  // 2. Order / transaction number printed on the photo.
  const numbers = new Set(
    [...extractOrderNumbers(input.texts), ...input.candidates].map(norm).filter(n => n.length >= 6),
  );
  const numberHits = orders.filter(o => o.orderNumber && numbers.has(norm(o.orderNumber)));
  if (numberHits.length === 1) {
    return { ...base, kind: kind === 'unknown' ? 'receipt' : kind, strength: 'exact', orderId: numberHits[0].id, reason: `Order number ${numberHits[0].orderNumber} is on the photo` };
  }
  if (numberHits.length > 1) {
    return { ...base, kind, strength: 'ambiguous', orderId: null, alternatives: numberHits.map(o => o.id), reason: 'Order number matches more than one order' };
  }

  // 3. Receipt amount + date (+ card).
  if (receipt.total == null && receipt.subtotal == null) {
    return { ...base, kind, strength: 'none', orderId: null, reason: kind === 'gift_card' ? 'No gift card on file has this number' : 'No order number or total found' };
  }

  const receiptDay = receipt.date ? dayNumber(receipt.date) : null;
  const capturedDay = input.capturedAt ? dayNumber(input.capturedAt) : null;
  const fits = orders.filter(o => {
    const amountOk = (receipt.subtotal != null && subtotalFits(receipt.subtotal, o)) || (receipt.total != null && totalFits(receipt.total, o));
    if (!amountOk) return false;
    const od = dayNumber(o.orderDate);
    if (receiptDay != null) return Math.abs(receiptDay - od) <= 2;
    // No date on the receipt: the photo was taken on or after the order, within two weeks.
    if (capturedDay != null) return capturedDay - od >= -1 && capturedDay - od <= 14;
    return false;
  });

  let pool = fits;
  let byCard = false;
  if (receipt.last4.length && fits.length) {
    const withCard = fits.filter(o => o.cardLast4s.some(l => receipt.last4.includes(l)));
    if (withCard.length) { pool = withCard; byCard = true; }
    // A receipt card that contradicts the order's card rules that order out.
    pool = pool.filter(o => !o.cardLast4s.length || o.cardLast4s.some(l => receipt.last4.includes(l)));
  }
  // An exact subtotal beats a total that only fits within the tax band.
  if (pool.length > 1 && receipt.subtotal != null) {
    const exactSub = pool.filter(o => subtotalFits(receipt.subtotal!, o));
    if (exactSub.length) pool = exactSub;
  }

  const amountText = receipt.subtotal != null ? `subtotal $${receipt.subtotal.toFixed(2)}` : `total $${receipt.total!.toFixed(2)}`;
  const when = receipt.date ? `dated ${receipt.date}` : 'photo date';
  if (pool.length === 1) {
    return {
      ...base, kind: 'receipt', strength: 'likely', orderId: pool[0].id,
      alternatives: fits.filter(o => o.id !== pool[0].id).map(o => o.id),
      reason: `Receipt ${amountText}, ${when}${byCard ? `, card ending ${receipt.last4.join('/')}` : ''}`,
    };
  }
  if (pool.length > 1) {
    return { ...base, kind: 'receipt', strength: 'ambiguous', orderId: null, alternatives: pool.map(o => o.id), reason: `${pool.length} orders fit the receipt ${amountText}, ${when}` };
  }
  return { ...base, kind: 'receipt', strength: 'none', orderId: null, reason: `No order fits the receipt ${amountText}, ${when}` };
}
