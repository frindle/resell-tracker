// The gift cards on a Costco warehouse receipt. Costco receipts mix gift
// cards with everything else bought on the trip ("282 UBER EATS 79.99" next
// to the groceries), and only the cards are a resale order. A gift card line
// is the one followed by its activation line ("PC 0000123456789012
// ACTIVATED"), which nothing else on the receipt has. Pure, no I/O.
//
// OCR rarely keeps a receipt's columns together: the price is usually its own
// line, and the lines don't come back in row order. So when the line boxes
// are known, an item is paired with the activation line just under it and the
// price on its own row; without boxes, only a price on the item's own line is
// used.

export type OcrBox = { text: string; box: [number, number, number, number] };

export type CostcoGiftLine = {
  /** The item name as printed, e.g. "UBER EATS", "DOORDASH GC". */
  name: string;
  /** What Costco charged for the item (one pack), or null if no price was read. */
  price: number | null;
  /** The activation number printed under it. */
  activation: string;
};

// "282 UBER EATS", "124 DOORDASH GC 79.99", "E 1473917 KS TRAIL MIX 17.59 A".
// The tax letter only ever follows a price: without one, a name's last letter
// would be taken for it.
const ITEM = /^\s*(?:E\s+)?\d{2,8}\s+([A-Z][A-Z0-9 .&'/-]{1,30}?)(?:\s+\$?(\d{1,5}\.\d{2})(?:\s*-?\s*[A-Z])?)?\s*$/;
const ACTIVATION = /\bPC\b\s*[:#]?\s*(\d[\d ]{10,24}\d)\s*ACTIV/i;
const PRICE = /^\s*\$?(\d{1,5}\.\d{2})\s*[A-Z]?\s*$/;
const NOT_ITEM = /\b(SUBTOTAL|TOTAL|TAX|CHANGE|BALANCE|VISA|MASTERCARD|AMEX|DEBIT|CREDIT|APPROVED|AMOUNT|MEMBER|ITEMS)\b/;

const digits = (s: string) => s.replace(/\D/g, '');

function itemOf(text: string): { name: string; price: number | null } | null {
  const m = text.match(ITEM);
  if (!m) return null;
  const name = m[1].trim().replace(/\s+/g, ' ');
  if (NOT_ITEM.test(name) || name.length < 3) return null;
  return { name, price: m[2] ? Number(m[2]) : null };
}

const cy = (b: OcrBox) => (b.box[1] + b.box[3]) / 2;
const h = (b: OcrBox) => Math.max(1e-4, b.box[3] - b.box[1]);

function fromBoxes(boxes: OcrBox[]): CostcoGiftLine[] {
  const items = boxes.map(b => ({ b, it: itemOf(b.text) })).filter((x): x is { b: OcrBox; it: { name: string; price: number | null } } => !!x.it);
  const prices = boxes.filter(b => PRICE.test(b.text));
  const out: CostcoGiftLine[] = [];
  const seenRows: number[] = [];
  for (const a of boxes) {
    const m = a.text.match(ACTIVATION);
    if (!m) continue;
    const n = digits(m[1]);
    if (n.length < 12) continue;
    // The same printed line read by another OCR variant: one card, not two.
    // Told apart by position, not by number: packs bought together can have
    // activation numbers a digit apart, and a misread can too.
    if (seenRows.some(y => Math.abs(y - cy(a)) < h(a) / 2)) continue;
    // Its item is the nearest item line above it, within a few rows.
    const above = items
      .filter(x => cy(x.b) < cy(a) && cy(a) - cy(x.b) < 3.5 * h(a))
      .sort((x, y) => cy(y.b) - cy(x.b));
    const item = above[0];
    if (!item) continue;
    seenRows.push(cy(a));
    let price = item.it.price;
    if (price == null) {
      // The price on the item's own row, to the right of the name.
      const row = prices
        .filter(p => Math.abs(cy(p) - cy(item.b)) < 0.6 * h(item.b) && p.box[0] > item.b.box[0])
        .sort((p, q) => Math.abs(cy(p) - cy(item.b)) - Math.abs(cy(q) - cy(item.b)));
      if (row[0]) price = Number(row[0].text.match(PRICE)![1]);
    }
    out.push({ name: item.it.name, price, activation: n });
  }
  return out;
}

function fromTexts(texts: string[]): CostcoGiftLine[] {
  const out: CostcoGiftLine[] = [];
  let last: { name: string; price: number | null } | null = null;
  for (const t of texts) {
    const it = itemOf(t);
    if (it) { last = it; continue; }
    const m = t.match(ACTIVATION);
    if (!m || !last) continue;
    const n = digits(m[1]);
    if (n.length < 12 || out.some(o => o.activation === n)) continue;
    out.push({ name: last.name, price: last.price, activation: n });
  }
  return out;
}

/**
 * The gift cards bought on a Costco receipt, one per activation line. Empty
 * when the receipt has no activated card. With boxes, items and prices are
 * paired by position; any line still missing a price takes the price of
 * another line with the same item name.
 */
export function costcoGiftLines(texts: string[], boxes?: OcrBox[] | null): CostcoGiftLine[] {
  // Positions tell one OCR variant's re-read from a second card; plain text
  // can't (a one-digit misread looks like another card), so it's the fallback.
  const viaBoxes = boxes?.length ? fromBoxes(boxes) : [];
  const lines = viaBoxes.length ? viaBoxes : fromTexts(texts);
  const key = (s: string) => s.replace(/[^A-Z0-9]/g, '');
  for (const l of lines) {
    if (l.price != null) continue;
    l.price = lines.find(o => o.price != null && key(o.name) === key(l.name))?.price ?? null;
  }
  return lines;
}
