/**
 * Cross-check entered gift-card codes against what OCR reads off the photo.
 *
 * DORMANT — see lib/giftCardOcr.ts. Nothing calls this outside the flag-gated
 * routes under app/api/giftcard-ocr/.
 *
 * The one rule everything here is built around: **OCR never writes a code.**
 * A human typed the code and a human is the authority; this only ever produces
 * a verdict. Even a unanimous, high-agreement OCR read that disagrees with the
 * stored code changes nothing but a flag.
 *
 * There are deliberately FOUR verdicts, not two. On the measured set, 12 of 28
 * images produced no DB-matching code, and for two entirely different reasons:
 * some were real cards never entered, and some were Costco receipts that are
 * not gift cards at all (IMG_3065 reads APPROVED PURCHASE / COSTCO WHOLESALE).
 * Collapsing those into "mismatch" would flag every receipt and teach the user
 * to ignore the flag inside a week, which costs more than the feature is worth.
 */

import type { GiftCardOcrResult, GiftCardOcrCandidate } from '@/lib/giftCardOcr';

export type GiftCardOcrVerdict =
  /** An OCR candidate equals the entered code. The value being produced. Silent. */
  | 'CONFIRMED'
  /** Well-formed candidates were read and none is the entered code. THE FLAG. */
  | 'MISMATCH'
  /** No candidate matches this card, but one matches a DIFFERENT known code —
   *  i.e. the photo is very likely attached to the wrong order. */
  | 'WRONG_CARD'
  /** Nothing code-shaped was read at all. Not a mismatch. */
  | 'NO_READ'
  /** The image does not look like a gift card (e.g. a receipt). Not a mismatch. */
  | 'NOT_APPLICABLE';

/** Verdicts that should actually surface to a human as something to look at. */
export const ACTIONABLE_VERDICTS: GiftCardOcrVerdict[] = ['MISMATCH', 'WRONG_CARD'];

/**
 * Normalise for comparison: uppercase, drop everything that is not A-Z0-9.
 * This is exactly what the service does to its own reads (`norm()` in
 * giftcard-ocr/pins.py), so both sides of the comparison are in the same space
 * and a stored "1234-5678" matches a read "12345678".
 *
 * It goes no further than that on purpose. No fuzzy matching, no edit-distance
 * threshold, no O/0 or I/1 folding: a near-match that silently passes is worse
 * than a flag, because it is the typo case the feature exists to catch.
 */
export function normalizeCode(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Words that mark an image as a receipt/document rather than a gift card.
 * Matched against normalised recognised text, and TWO distinct markers are
 * required — a single one is too easy to hit by accident on a real card
 * (plenty of gift cards say "TOTAL" or "MEMBER" somewhere).
 */
const RECEIPT_MARKERS = [
  'APPROVEDPURCHASE',
  'COSTCOWHOLESALE',
  'COSTCO',
  'WHOLESALE',
  'SUBTOTAL',
  'TOTALTAX',
  'AMOUNTDUE',
  'MERCHANTID',
  'AUTHCODE',
  'CHANGEDUE',
  'CASHIER',
  'THANKYOUFORSHOPPING',
  'ITEMSSOLD',
  'MEMBER',
];

/** Which receipt markers the recognised text contains. Exported so a flag can
 *  be explained ("we called this a receipt because ...") rather than asserted. */
export function receiptMarkers(texts: string[]): string[] {
  const blob = texts.map(normalizeCode).join(' ');
  return RECEIPT_MARKERS.filter(m => blob.includes(m));
}

export function looksLikeReceipt(texts: string[]): boolean {
  return receiptMarkers(texts).length >= 2;
}

/**
 * Levenshtein distance, capped — DIAGNOSTIC ONLY.
 *
 * Stated explicitly because the rule elsewhere in this file is "no fuzzy
 * matching": this value is attached to the audit record so a human looking at
 * a MISMATCH can see at a glance whether it is a one-character typo or a
 * completely different code. It is never compared against a threshold and it
 * never influences a verdict.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export type GiftCardOcrCheck = {
  verdict: GiftCardOcrVerdict;
  /** Human-readable reason, so a flag can be understood without re-deriving it. */
  reason: string;
  /** The stored code(s) this was checked against, normalised. */
  expected: string[];
  /** The candidate that matched, when CONFIRMED. */
  matched?: string;
  /** How many variants produced the matching candidate, when CONFIRMED. */
  matchedAgreement?: number;
  /** For WRONG_CARD: the candidate and the other record it belongs to. */
  foundElsewhere?: { pin: string; owner: string };
  /**
   * Diagnostic only (see editDistance): the candidate closest to the entered
   * code and how far off it is. Never affects `verdict`.
   */
  nearest?: { pin: string; distance: number };
  /** Receipt markers that were found, if any. */
  receiptMarkers: string[];
};

/**
 * Full audit payload for one image checked against one card. Deliberately
 * self-contained: which variants ran, what each returned, what was compared and
 * why the verdict came out the way it did. A flag that cannot be investigated
 * is a flag that gets switched off.
 */
export type GiftCardOcrAudit = GiftCardOcrCheck & {
  checkedAt: string;
  modelSet: string;
  variants: { variant: string; candidates: string[]; nBoxes: number; elapsedS: number }[];
  candidates: GiftCardOcrCandidate[];
};

export type ExpectedCard = {
  /** Identifier for reporting — a GiftCard row id, usually. */
  id: number | string;
  cardNumber?: string | null;
  pin?: string | null;
  /** Free-text label for messages, e.g. "DoorDash $100". */
  label?: string;
};

/**
 * Compare one OCR result against one card's entered code(s).
 *
 * `knownCodes` maps a normalised code from elsewhere in the database to a
 * description of what owns it, and only exists to distinguish "this is a typo"
 * from "this photo is on the wrong order". Pass an empty map to skip that.
 */
export function checkCardAgainstOcr(
  card: ExpectedCard,
  ocr: GiftCardOcrResult,
  knownCodes: Map<string, string> = new Map(),
): GiftCardOcrCheck {
  const expected = [card.cardNumber, card.pin]
    .map(normalizeCode)
    .filter(c => c.length > 0);
  const markers = receiptMarkers(ocr.texts ?? []);
  const candidates = ocr.candidates ?? [];
  const pins = candidates.map(c => c.pin);

  // 1. A match wins outright, even on an image that also looks like a receipt
  //    (a card photographed on top of its receipt is a real thing).
  for (const cand of candidates) {
    if (expected.includes(cand.pin)) {
      return {
        verdict: 'CONFIRMED',
        reason: `OCR read the entered code (${cand.agreement} of ${ocr.variants.length} variants agreed)`,
        expected,
        matched: cand.pin,
        matchedAgreement: cand.agreement,
        receiptMarkers: markers,
      };
    }
  }

  const nearest = expected.length && pins.length
    ? pins
      .map(p => ({ pin: p, distance: Math.min(...expected.map(e => editDistance(e, p))) }))
      .sort((a, b) => a.distance - b.distance)[0]
    : undefined;

  // 2. Nothing code-shaped came back at all.
  if (!pins.length) {
    return markers.length >= 2
      ? {
        verdict: 'NOT_APPLICABLE',
        reason: `No code found and the text looks like a receipt (${markers.join(', ')})`,
        expected, receiptMarkers: markers,
      }
      : {
        verdict: 'NO_READ',
        reason: 'No code-shaped text found in this image',
        expected, receiptMarkers: markers,
      };
  }

  // 3. Codes were read, but not this card's. Is one of them another card's?
  for (const cand of candidates) {
    const owner = knownCodes.get(cand.pin);
    if (owner) {
      return {
        verdict: 'WRONG_CARD',
        reason: `OCR read a code belonging to ${owner}, not this card — the photo may be on the wrong record`,
        expected,
        foundElsewhere: { pin: cand.pin, owner },
        nearest,
        receiptMarkers: markers,
      };
    }
  }

  // 4. Receipts carry code-shaped numbers of their own (transaction barcodes
  //    are 16 digits). Check this BEFORE calling it a mismatch, or every
  //    receipt in the pile becomes a false flag.
  if (markers.length >= 2) {
    return {
      verdict: 'NOT_APPLICABLE',
      reason: `Image looks like a receipt, not a gift card (${markers.join(', ')})`,
      expected, nearest, receiptMarkers: markers,
    };
  }

  if (!expected.length) {
    return {
      verdict: 'NO_READ',
      reason: 'Nothing to compare against — this card has no code entered',
      expected, receiptMarkers: markers,
    };
  }

  // 5. The flag.
  return {
    verdict: 'MISMATCH',
    reason: `OCR read ${pins.length} code(s), none matching the entered code`,
    expected, nearest, receiptMarkers: markers,
  };
}

export function auditFor(check: GiftCardOcrCheck, ocr: GiftCardOcrResult): GiftCardOcrAudit {
  return {
    ...check,
    checkedAt: new Date().toISOString(),
    modelSet: ocr.model_set,
    variants: (ocr.variants ?? []).map(v => ({
      variant: v.variant,
      candidates: v.candidates,
      nBoxes: v.n_boxes,
      elapsedS: v.elapsed_s,
    })),
    candidates: ocr.candidates ?? [],
  };
}

/**
 * Order-level roll-up: several photos, several cards, and no guarantee of a
 * one-to-one mapping between them (one photo often shows several cards — the
 * measured set has images carrying two distinct 16-digit codes).
 *
 * So candidates are pooled across every image on the order before any card is
 * judged. Judging photo-by-photo would flag every card that simply happens not
 * to be in that particular photo.
 */
export function verifyOrderCards(
  cards: ExpectedCard[],
  images: { id: number | string; name: string; ocr: GiftCardOcrResult }[],
  knownCodes: Map<string, string> = new Map(),
) {
  const pooled: GiftCardOcrResult = {
    ok: true,
    model_set: images[0]?.ocr.model_set ?? 'unknown',
    long_edge: images[0]?.ocr.long_edge ?? 0,
    elapsed_s: images.reduce((n, i) => n + (i.ocr.elapsed_s || 0), 0),
    variants: images.flatMap(i => i.ocr.variants ?? []),
    candidates: dedupeCandidates(images.flatMap(i => i.ocr.candidates ?? [])),
    texts: images.flatMap(i => i.ocr.texts ?? []),
    consensus: Array.from(new Set(images.flatMap(i => i.ocr.consensus ?? []))),
  };

  const results = cards.map(card => {
    const check = checkCardAgainstOcr(card, pooled, knownCodes);
    return { card, ...auditFor(check, pooled) };
  });

  return {
    imageCount: images.length,
    cardCount: cards.length,
    flagged: results.filter(r => ACTIONABLE_VERDICTS.includes(r.verdict)).length,
    results,
  };
}

/** Merge duplicate candidates from different images, keeping the best agreement. */
function dedupeCandidates(all: GiftCardOcrCandidate[]): GiftCardOcrCandidate[] {
  const by = new Map<string, GiftCardOcrCandidate>();
  for (const c of all) {
    const prev = by.get(c.pin);
    if (!prev || c.agreement > prev.agreement) by.set(c.pin, c);
  }
  return Array.from(by.values()).sort((a, b) => b.agreement - a.agreement || a.pin.localeCompare(b.pin));
}
