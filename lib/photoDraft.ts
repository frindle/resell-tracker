// A new order filled in from a photo that matched no existing order. It is
// only a proposal: it lives on the PhotoOcr row, shows in the Sort & Assign
// review queue, and no Order exists until the user confirms it. Pure, no I/O.
import { prefillFromPhoto } from './photoPrefill.ts';
import { costcoBarcodes, printedCostcoBarcodes } from './photoMatch.ts';
import { costcoGiftLines, type CostcoGiftLine, type OcrBox } from './costcoGiftLines.ts';

export type PhotoDraft = {
  platform: string;
  orderNumber: string | null;
  /** YYYY-MM-DD */
  orderDate: string;
  cost: string;
  cardId: number | null;
  itemDescription: string | null;
};

export type DraftCtx = {
  platforms: string[];
  merchants: string[];
  cards: { id: number; last4s: string[] }[];
  /** Earlier orders' item descriptions, newest first, for a gift card's face value. */
  pastItems?: { platform: string; itemDescription: string }[];
};

// "282 UBER EATS 79.99", "124 DOORDASH GC 79.99": item number, name, price.
const ITEM = /^\s*\d{2,8}\s+([A-Z][A-Z0-9 .&'/-]{2,32}?)\s+\$?\d{1,5}\.\d{2}\b/;
const NOT_ITEMS = /\b(SUBTOTAL|TOTAL|TAX|CHANGE|BALANCE|VISA|MASTERCARD|AMEX|DEBIT|CREDIT|APPROVED|AMOUNT)\b/;

/** Item names printed on a receipt, in order, at most 5. */
export function receiptItems(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const m = t.match(ITEM);
    if (!m) continue;
    const name = m[1].trim().replace(/\s+/g, ' ');
    if (NOT_ITEMS.test(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length === 5) break;
  }
  return out;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The brand a receipt line names ("UBER EATS" -> "Uber Eats"), the longest known merchant name first. */
function brandOf(name: string, merchants: string[]): string {
  const k = key(name);
  let best = '';
  for (const m of merchants) {
    const mk = key(m);
    if (mk.length >= 3 && k.includes(mk) && mk.length > key(best).length) best = m;
  }
  if (best) return best;
  const plain = name.replace(/\s+(E?GC|GIFT\s*CARDS?)$/i, '').toLowerCase();
  return plain.replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** The face value the latest order for this brand at this store used ("$50 Doordash GC" -> 50). */
function faceValue(brand: string, platform: string, past: { platform: string; itemDescription: string }[]): number | null {
  const first = key(brand.split(/\s+/)[0] ?? brand);
  if (first.length < 3) return null;
  for (const p of past) {
    if (key(p.platform) !== key(platform) || !key(p.itemDescription).includes(first)) continue;
    const amounts = [...p.itemDescription.matchAll(/\$(\d{1,4})(?![\d.])/g)].map(m => Number(m[1]));
    if (amounts.length === 1) return amounts[0];
  }
  return null;
}

/**
 * "$50 Uber Eats & DoorDash GC": the brands in receipt order, with a face
 * value when every brand's last order used the same one.
 */
export function giftDescription(lines: CostcoGiftLine[], platform: string, ctx: DraftCtx): string {
  const brands: string[] = [];
  for (const l of lines) {
    const b = brandOf(l.name, ctx.merchants);
    if (!brands.includes(b)) brands.push(b);
  }
  const faces = brands.map(b => faceValue(b, platform, ctx.pastItems ?? []));
  const face = faces.length && faces.every(f => f != null && f === faces[0]) ? faces[0] : null;
  return `${face != null ? `$${face} ` : ''}${brands.join(' & ')} GC`;
}

/**
 * What the gift cards on the receipt cost: the sum of their lines. A line
 * whose price wasn't read takes the middle price of the others; with no price
 * read at all, null.
 */
function giftCost(lines: CostcoGiftLine[]): number | null {
  const known = lines.map(l => l.price).filter((p): p is number => p != null).sort((a, b) => a - b);
  if (!known.length) return null;
  const mid = known[Math.floor(known.length / 2)];
  return lines.reduce((sum, l) => sum + (l.price ?? mid), 0);
}

/**
 * A draft order from a receipt photo, or null when the photo doesn't carry
 * enough to make one (a store, a date and an amount are all required).
 */
export function draftFromPhoto(
  input: {
    kind: string | null; texts: string[]; candidates: string[]; capturedAt?: string | Date | null;
    /** Line boxes of the reading the texts came from, to pair a receipt's items with their prices. */
    boxes?: OcrBox[] | null;
  },
  ctx: DraftCtx,
): PhotoDraft | null {
  if (input.kind !== 'receipt') return null;
  const p = prefillFromPhoto(input, ctx);
  if (!p.platform || !p.cost || !p.orderDate) return null;

  // Costco: the transaction number printed under the receipt's barcode, else
  // rebuilt from the summary line. Only a date printed on the photo counts for
  // a rebuilt one, not the photo's own date.
  const rebuilt = costcoBarcodes(input.texts);
  const printed = printedCostcoBarcodes(input.texts);
  const printedBoth = printed.filter(c => rebuilt.includes(c));
  const printedPick = printed.length === 1 ? printed[0] : printedBoth.length === 1 ? printedBoth[0] : null;
  const orderNumber = printedPick ?? p.orderNumber ?? (rebuilt.length === 1 ? rebuilt[0] : null);

  // A receipt with activated gift cards on it (Costco mixes them with the
  // rest of the trip): the order is the cards alone.
  const gifts = costcoGiftLines(input.texts, input.boxes);
  const giftTotal = gifts.length ? giftCost(gifts) : null;
  const items = receiptItems(input.texts);
  return {
    platform: p.platform,
    orderNumber,
    orderDate: p.orderDate,
    cost: giftTotal != null ? giftTotal.toFixed(2) : p.cost,
    cardId: p.cardId ?? null,
    itemDescription: gifts.length ? giftDescription(gifts, p.platform, ctx) : items.length ? items.join(', ') : null,
  };
}
