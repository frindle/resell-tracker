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
  /** When each photo already on the order was taken (uploader-sent times only). */
  photoTimes?: (string | Date)[];
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

/**
 * Every identifier-looking string printed on the photo: each OCR line and
 * each word of it, normalised, 10+ characters (an unlabelled short number
 * could be a store id or quantity). Lets an unlabelled number (a Costco
 * receipt barcode) match an order number exactly.
 */
export function printedIds(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const piece of [t, ...t.split(/\s+/)]) {
      const n = norm(piece);
      if (n.length >= 10 && /\d/.test(n)) out.add(n);
    }
  }
  return [...out];
}

/**
 * Costco transaction barcodes rebuilt from the summary line every Costco
 * receipt (and gift card summary receipt) prints:
 *   "10/28/2026 11:53 1320 9 75 13"  (date, time, warehouse, register, transaction, operator)
 * -> "21" + warehouse(4) + register(3) + transaction(4) + YYMMDD + HHMM
 * -> 21132000900752610281153, the number stored as the order number.
 * OCR often reads the date (printed white-on-black) apart from the rest, so
 * the date comes from anywhere on the photo; with no date at all, every day of
 * the 31 before the photo was taken is tried (still an exact 23-digit match).
 */
export function costcoBarcodes(texts: string[], capturedAt?: string | Date | null): string[] {
  const joined = texts.join(' ');
  const tail = /\b([01]?\d|2[0-3]):([0-5]\d)\s+(\d{3,4})\s+(\d{1,3})\s+(\d{1,4})\s+\d{1,4}\b/g;
  const dates = new Set<string>();
  for (const m of joined.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) {
    dates.add(`${m[3].slice(2)}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`);
  }
  if (!dates.size && capturedAt) {
    const end = Date.parse(typeof capturedAt === 'string' ? capturedAt : capturedAt.toISOString());
    if (!isNaN(end)) {
      for (let i = 0; i <= 31; i++) dates.add(new Date(end - i * DAY).toISOString().slice(2, 10).replace(/-/g, ''));
    }
  }
  const out = new Set<string>();
  for (const m of joined.matchAll(tail)) {
    const [, hh, mm, wh, reg, trn] = m;
    for (const d of dates) {
      out.add(`21${wh.padStart(4, '0')}${reg.padStart(3, '0')}${trn.padStart(4, '0')}${d}${hh.padStart(2, '0')}${mm}`);
    }
  }
  return [...out];
}

/**
 * Costco transaction barcodes printed whole on the photo (the 23 digits under
 * the register receipt's barcode), checked for a real date and time so a
 * member or card number is never taken for one.
 */
export function printedCostcoBarcodes(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.replace(/\s+/g, '').matchAll(/(?<!\d)21\d{21}(?!\d)/g)) {
      if (parseCostcoBarcode(m[0])) out.add(m[0]);
    }
  }
  return [...out];
}

export type CostcoTxn = { warehouse: number; register: number; transaction: number };

/** A Costco transaction barcode taken apart, or null if it isn't one. */
export function parseCostcoBarcode(s: string | null | undefined): (CostcoTxn & { date: string; time: string }) | null {
  const m = norm(s ?? '').match(/^21(\d{4})(\d{3})(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, wh, reg, trn, yy, mo, dd, hh, mi] = m;
  if (+mo < 1 || +mo > 12 || +dd < 1 || +dd > 31 || +hh > 23 || +mi > 59) return null;
  return { warehouse: +wh, register: +reg, transaction: +trn, date: `20${yy}-${mo}-${dd}`, time: `${hh}:${mi}` };
}

/**
 * Warehouse, register and transaction from every summary line on the photo
 * ("13:23 1320 8 231 8"). A gift card activation receipt prints the same
 * transaction as the register receipt, a minute or so earlier, so its rebuilt
 * barcode differs in the time; these three numbers don't.
 */
export function costcoTransactions(texts: string[]): CostcoTxn[] {
  const out = new Map<string, CostcoTxn>();
  for (const t of texts) {
    for (const m of t.matchAll(/([01]?\d|2[0-3]):[0-5]\d\s+(\d{3,4})\s+(\d{1,3})\s+(\d{1,4})\s+\d{1,4}\b/g)) {
      const x = { warehouse: +m[2], register: +m[3], transaction: +m[4] };
      out.set(`${x.warehouse}-${x.register}-${x.transaction}`, x);
    }
  }
  return [...out.values()];
}

/**
 * The photo lines a rebuilt Costco order number came from (see costcoBarcodes):
 * the time/warehouse/register/transaction line and the date line. Empty for
 * any other kind of order number.
 */
export function costcoSourceLines(texts: string[], orderNumber: string): string[] {
  const s = norm(orderNumber);
  if (!/^21\d{21}$/.test(s)) return [];
  const n = (a: number, b: number) => String(Number(s.slice(a, b)));
  const [wh, reg, trn, yy, mo, dd, hh, mm] = [n(2, 6), n(6, 9), n(9, 13), s.slice(13, 15), n(15, 17), n(17, 19), n(19, 21), s.slice(21, 23)];
  const pats = [
    new RegExp(`\\b0?${hh}:${mm}\\b`),
    new RegExp(`\\b0*${wh}\\s+0*${reg}\\s+0*${trn}\\b`),
    new RegExp(`\\b0?${mo}/0?${dd}/20${yy}\\b`),
  ];
  return texts.filter(t => pats.some(p => p.test(t)));
}

/** Photos taken this close together count as one shopping trip. */
const SAME_SHOOT_MS = 20 * 60_000;

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
  input: {
    texts: string[]; candidates: string[]; looksLikeReceipt: boolean; capturedAt?: string | Date | null;
    /** When the phone took the photo, only if the uploader sent it (never the upload time). */
    takenAt?: string | Date | null;
  },
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
    [
      ...extractOrderNumbers(input.texts), ...input.candidates,
      ...printedIds(input.texts), ...costcoBarcodes(input.texts, input.capturedAt),
    ].map(norm).filter(n => n.length >= 6),
  );
  const numberHits = orders.filter(o => o.orderNumber && numbers.has(norm(o.orderNumber)));
  if (numberHits.length === 1) {
    return { ...base, kind: kind === 'unknown' ? 'receipt' : kind, strength: 'exact', orderId: numberHits[0].id, reason: `Order number ${numberHits[0].orderNumber} is on the photo` };
  }
  if (numberHits.length > 1) {
    return { ...base, kind, strength: 'ambiguous', orderId: null, alternatives: numberHits.map(o => o.id), reason: 'Order number matches more than one order' };
  }

  // 2c. The same Costco transaction: a gift card activation receipt (alone or
  // photographed with its cards) names the warehouse, register and
  // transaction of an order whose number is that trip's register barcode.
  const txns = costcoTransactions(input.texts);
  if (txns.length) {
    const photoDay = receipt.date ? dayNumber(receipt.date) : input.capturedAt ? dayNumber(input.capturedAt) : null;
    const hits = orders.flatMap(o => {
      const b = parseCostcoBarcode(o.orderNumber);
      if (!b || !txns.some(t => t.warehouse === b.warehouse && t.register === b.register && t.transaction === b.transaction)) return [];
      const gap = photoDay == null ? null : photoDay - dayNumber(b.date);
      // A printed date must be that day; a photo date may be up to 3 days later.
      if (gap == null || (receipt.date ? gap !== 0 : gap < 0 || gap > 3)) return [];
      return [{ o, b, printed: !!receipt.date }];
    });
    if (hits.length === 1) {
      const { o, b, printed } = hits[0];
      return {
        ...base, kind: kind === 'unknown' ? 'receipt' : kind, strength: printed ? 'exact' : 'likely', orderId: o.id,
        reason: `Costco warehouse ${b.warehouse}, register ${b.register}, transaction ${b.transaction} is on the photo${printed ? `, dated ${receipt.date}` : ''}`,
      };
    }
    if (hits.length > 1) {
      return { ...base, kind, strength: 'ambiguous', orderId: null, alternatives: hits.map(h => h.o.id), reason: 'The Costco transaction on the photo is on more than one order' };
    }
  }

  // 3. Receipt amount + date (+ card).
  if (receipt.total == null && receipt.subtotal == null) {
    // 2b. A gift card photographed alongside an order's receipt: cards bought
    // together are usually shot within minutes of the receipt. Never exact, so
    // it always goes to the review queue.
    if (kind === 'gift_card' && input.takenAt) {
      const t = Date.parse(String(input.takenAt instanceof Date ? input.takenAt.toISOString() : input.takenAt));
      const gap = (o: MatchOrder) => Math.min(...(o.photoTimes ?? []).map(p => Math.abs(Date.parse(p instanceof Date ? p.toISOString() : p) - t)));
      const close = orders.filter(o => gap(o) <= SAME_SHOOT_MS);
      if (close.length === 1) {
        const mins = Math.round(gap(close[0]) / 60_000);
        return { ...base, kind, strength: 'likely', orderId: close[0].id, reason: `No gift card on file has this number; taken ${mins <= 1 ? 'within a minute' : `${mins} minutes`} of a photo on this order` };
      }
      if (close.length > 1) {
        return { ...base, kind, strength: 'ambiguous', orderId: null, alternatives: close.map(o => o.id), reason: 'Taken around the same time as photos on more than one order' };
      }
    }
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
