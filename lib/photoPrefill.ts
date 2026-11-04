// Turns what OCR read off an unsorted photo into New Order form values:
// order number, date, price and card from a receipt; card number, PIN,
// value and brand from a gift card. Pure, no I/O. Every field is a guess
// the user reviews before saving, so it only fills what it found.
import { parseReceipt } from './receiptParse.ts';
import { extractOrderNumbers } from './orderNumberExtract.ts';

export type PrefillInput = {
  kind: string | null;
  texts: string[];
  candidates: string[];
  capturedAt?: string | Date | null;
};

export type PrefillGiftCard = { merchant: string; value: string; cardNumber: string; pin: string };

export type Prefill = {
  platform?: string;
  orderNumber?: string;
  /** YYYY-MM-DD */
  orderDate?: string;
  cost?: string;
  cardId?: number;
  giftCard?: PrefillGiftCard;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Longest known name that appears in the text, so "Best Buy" wins over "Buy". */
function findName(texts: string[], names: string[]): string | undefined {
  const hay = norm(texts.join(' '));
  let best: string | undefined;
  for (const n of names) {
    const k = norm(n);
    if (k.length >= 3 && hay.includes(k) && (!best || k.length > norm(best).length)) best = n;
  }
  return best;
}

const PIN_LABEL = /\bPIN\b\s*[:#]?\s*([0-9]{3,8})\b/i;
const DOLLARS = /\$\s*(\d{1,4})(?:\.(\d{2}))?\b/g;

function giftCardFrom(input: PrefillInput, merchants: string[]): PrefillGiftCard | undefined {
  // Card numbers are the long codes; a PIN is short and usually labelled.
  const codes = [...new Set(input.candidates)].sort((a, b) => b.length - a.length);
  const cardNumber = codes.find(c => c.length >= 10);
  if (!cardNumber) return undefined;

  let pin = '';
  for (const t of input.texts) {
    const m = t.match(PIN_LABEL);
    if (m) { pin = m[1]; break; }
  }
  if (!pin) pin = codes.find(c => c !== cardNumber && /^\d{3,8}$/.test(c)) ?? '';

  // The face value: the largest whole-dollar amount printed, capped at a sane card size.
  let value = 0;
  for (const t of input.texts) {
    for (const m of t.matchAll(DOLLARS)) {
      const v = Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
      if (v > value && v <= 2000) value = v;
    }
  }

  return {
    merchant: findName(input.texts, merchants) ?? '',
    value: value ? String(value) : '',
    cardNumber,
    pin,
  };
}

export function prefillFromPhoto(
  input: PrefillInput,
  ctx: { platforms: string[]; merchants: string[]; cards: { id: number; last4s: string[] }[] },
): Prefill {
  const out: Prefill = {};
  const platform = findName(input.texts, ctx.platforms);
  if (platform) out.platform = platform;

  const gc = input.kind !== 'receipt' ? giftCardFrom(input, ctx.merchants) : undefined;
  if (gc) out.giftCard = gc;

  if (input.kind !== 'gift_card') {
    const r = parseReceipt(input.texts);
    const price = r.subtotal ?? r.total;
    if (price != null) out.cost = price.toFixed(2);
    if (r.date) out.orderDate = r.date;
    // Only a card that is the single one with that last 4.
    const hits = ctx.cards.filter(c => c.last4s.some(l => r.last4.includes(l)));
    if (hits.length === 1) out.cardId = hits[0].id;
    const nums = extractOrderNumbers(input.texts);
    if (nums.length === 1) out.orderNumber = nums[0];
  }

  if (!out.orderDate && input.capturedAt) {
    const d = new Date(input.capturedAt);
    if (!isNaN(d.getTime())) out.orderDate = d.toISOString().slice(0, 10);
  }
  return out;
}
