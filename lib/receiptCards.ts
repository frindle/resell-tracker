// Which of an order's gift cards a receipt photo covers. Pure, no I/O.
//
// A receipt can't be matched by card code: a Costco receipt (and its gift
// card summary slip) prints each pack's activation serial, never the codes
// printed on the cards. What the receipt and the cards share is the
// merchant: "UBER EATS", "DOORDASH GC". So a receipt on an order covers the
// order's cards whose merchant is printed on it.
//
// Receipts are linked to the cards they cover but never sent to CardCenter
// (lib/cardcenterImagesDeps.ts): they carry the member number and payment card.
import { normalizeCode } from './giftCardOcrVerify.ts';

export type ReceiptCard = { id: number; merchant: string; cardNumber: string };

export type ReceiptPhoto = {
  attachmentId: number;
  /** The photo's receipt flag: true a receipt, false a card photo (both set by hand or by an earlier match), null not decided. */
  receipt: boolean | null;
  /** What photo reading called it: gift_card | receipt | unknown. */
  kind: string | null;
  texts: string[];
  candidates: string[];
  /** Cards this photo is already linked to. */
  linkedCardIds: number[];
};

export type ReceiptPlan = {
  links: { attachmentId: number; cardId: number }[];
  /** Read as receipts (not decided before): set their receipt flag. */
  markReceipt: number[];
};

/** The merchant's name, or its first word (4+ letters: "UBER" for Uber Eats), is printed on the receipt. */
export function merchantOnReceipt(merchant: string, texts: string[]): boolean {
  const blob = normalizeCode(texts.join(' '));
  const full = normalizeCode(merchant);
  if (full.length >= 3 && blob.includes(full)) return true;
  const first = normalizeCode(merchant.trim().split(/\s+/)[0]);
  return first.length >= 4 && first !== full && blob.includes(first);
}

/** A card code on the order shows on the photo (same exact 8+ character rule as card photos). */
function showsCardCode(p: ReceiptPhoto, cards: ReceiptCard[]): boolean {
  const cand = new Set(p.candidates.map(normalizeCode));
  const joined = normalizeCode(p.texts.join(''));
  return cards.some(c => {
    const n = normalizeCode(c.cardNumber);
    return n.length >= 8 && (cand.has(n) || joined.includes(n));
  });
}

/**
 * Links receipts to the order's cards they cover. A photo counts as a receipt
 * when its flag is set, or when it was read as a receipt, shows no card code
 * (a photo of the cards with the slip in the frame stays a card photo) and
 * names at least one of the order's cards. Only adds links.
 */
export function planReceiptLinks(photos: ReceiptPhoto[], cards: ReceiptCard[]): ReceiptPlan {
  const plan: ReceiptPlan = { links: [], markReceipt: [] };
  for (const p of photos) {
    if (p.receipt === false) continue;
    if (p.receipt == null && (p.kind !== 'receipt' || showsCardCode(p, cards))) continue;
    const covers = cards.filter(c => merchantOnReceipt(c.merchant, p.texts)).map(c => c.id);
    if (p.receipt == null) {
      if (!covers.length) continue;
      plan.markReceipt.push(p.attachmentId);
    }
    const have = new Set(p.linkedCardIds);
    for (const id of covers) if (!have.has(id)) plan.links.push({ attachmentId: p.attachmentId, cardId: id });
  }
  return plan;
}
