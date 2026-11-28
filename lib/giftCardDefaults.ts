// What the gift-card OCR review pre-fills for a code it read: the card's brand and face value. Only a starting point a
// person checks before saving (nothing here writes). Pure, no I/O.
import { canonicalGiftBrand } from './giftBrand.ts';

const GIFT = /\b(e-?gift|gift\s*cards?|e?gcs?)\b/i;
// "$100", "$ 50", "$25.00"; not "$12.99" or "$1,000".
const AMOUNT = /\$\s?(\d{1,4})(?:\.00)?(?![\d.,])/g;
const MIN_FACE = 5;
const MAX_FACE = 2000;

/** The one face value a text names ("$100 DoorDash GC" -> 100), or null when it names none or several. */
export function faceValueIn(text: string | null | undefined): number | null {
  const found = new Set<number>();
  for (const m of String(text ?? '').matchAll(AMOUNT)) {
    const n = Number(m[1]);
    if (n >= MIN_FACE && n <= MAX_FACE) found.add(n);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The card brand an order's item description names ("2x $50 DoorDash GC" -> "DoorDash"), or '' when it is not a gift
 * card description or names more than one brand ("$50 Uber Eats & DoorDash GC").
 */
export function brandFromDescription(desc: string | null | undefined): string {
  const s = String(desc ?? '').trim();
  if (!s || !GIFT.test(s) || /&|\+|,|\/|\band\b/i.test(s)) return '';
  const name = s
    .replace(/^\s*\d+\s*x\s+/i, ' ')
    .replace(/\$\s?\d{1,4}(?:\.\d{2})?/g, ' ')
    .replace(/\b(e-?gift|gift\s*cards?|e?gcs?|cards?|physical|digital|email(ed)?|delivery)\b/gi, ' ')
    .replace(/[-–—:()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 32 || /\d/.test(name)) return '';
  return canonicalGiftBrand(name);
}

export type CardDefaults = {
  merchant: string;
  merchantFrom: 'cards' | 'order' | null;
  value: number | null;
  valueFrom: 'cards' | 'order' | null;
};

/**
 * The order-wide defaults: a brand and value already on this order's cards (the value only when they all share it), else
 * what the order's item description names, else blank.
 */
export function orderCardDefaults(
  itemDescription: string | null | undefined,
  cards: readonly { merchant: string; value: number }[],
): CardDefaults {
  const fromCards = cards[0]?.merchant?.trim() ?? '';
  const brand = fromCards || brandFromDescription(itemDescription);
  const values = new Set(cards.map(c => c.value).filter(v => Number(v) > 0));
  const descValue = GIFT.test(String(itemDescription ?? '')) ? faceValueIn(itemDescription) : null;
  const value = values.size === 1 ? [...values][0] : descValue;
  return {
    merchant: brand,
    merchantFrom: fromCards ? 'cards' : brand ? 'order' : null,
    value,
    valueFrom: values.size === 1 ? 'cards' : value != null ? 'order' : null,
  };
}

/** One read code's value: the single amount printed on its own photo beats the order's default. */
export function suggestionValue(photoTexts: readonly string[], d: CardDefaults): { value: number | null; valueFrom: 'photo' | 'cards' | 'order' | null } {
  const own = faceValueIn(photoTexts.join('\n'));
  return own != null ? { value: own, valueFrom: 'photo' } : { value: d.value, valueFrom: d.valueFrom };
}
