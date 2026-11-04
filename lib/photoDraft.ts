// A new order filled in from a photo that matched no existing order. It is
// only a proposal: it lives on the PhotoOcr row, shows in the Sort & Assign
// review queue, and no Order exists until the user confirms it. Pure, no I/O.
import { prefillFromPhoto } from './photoPrefill.ts';
import { costcoBarcodes } from './photoMatch.ts';

export type PhotoDraft = {
  platform: string;
  orderNumber: string | null;
  /** YYYY-MM-DD */
  orderDate: string;
  cost: string;
  cardId: number | null;
  itemDescription: string | null;
};

export type DraftCtx = { platforms: string[]; merchants: string[]; cards: { id: number; last4s: string[] }[] };

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

/**
 * A draft order from a receipt photo, or null when the photo doesn't carry
 * enough to make one (a store, a date and an amount are all required).
 */
export function draftFromPhoto(
  input: { kind: string | null; texts: string[]; candidates: string[]; capturedAt?: string | Date | null },
  ctx: DraftCtx,
): PhotoDraft | null {
  if (input.kind !== 'receipt') return null;
  const p = prefillFromPhoto(input, ctx);
  if (!p.platform || !p.cost || !p.orderDate) return null;

  let orderNumber = p.orderNumber ?? null;
  if (!orderNumber) {
    // Costco: the transaction barcode, rebuilt from the summary line. Only a
    // date printed on the photo counts here, not the photo's own date.
    const codes = costcoBarcodes(input.texts);
    if (codes.length === 1) orderNumber = codes[0];
  }
  const items = receiptItems(input.texts);
  return {
    platform: p.platform,
    orderNumber,
    orderDate: p.orderDate,
    cost: p.cost,
    cardId: p.cardId ?? null,
    itemDescription: items.length ? items.join(', ') : null,
  };
}
