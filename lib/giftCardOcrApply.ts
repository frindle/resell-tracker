// Write path of the photo-OCR accept flow, extracted from the apply route so it
// can be tested without a database. OCR never writes a code on its own: this
// only persists what the user submitted from the review screen.
import { normalizeCode } from './giftCardOcrVerify.ts';

// Matches the whitespace stripping the ordinary gift-card route applies, so a
// code entered here and the same code entered on the form land identically.
function stripWs(s: string) {
  return s.replace(/\s+/g, '');
}

export type AcceptedCode = {
  /** What the user is actually saving. Authoritative. */
  cardNumber: string;
  pin?: string | null;
  merchant: string;
  value: number;
  /** What OCR proposed, if anything: used only to derive provenance. */
  suggested?: string | null;
  /** Variants that agreed on the suggestion at the time it was shown. */
  agreement?: number | null;
  /** The photo this code was read from. Linked to the new card when it belongs to the order. */
  attachmentId?: number | null;
};

export interface ApplyDeps<T extends { id: number } = { id: number }> {
  existingNumbers(): Promise<string[]>;
  /** Looks the attachment up scoped to THIS order; null when it is not on it. */
  findAttachment(attachmentId: number): Promise<{ id: number; giftCardId: number | null } | null>;
  createCard(data: {
    merchant: string; value: number; cardNumber: string; pin: string | null;
    codeSource: string; codeOcrAgreement: number | null;
  }): Promise<T>;
  linkAttachment(attachmentId: number, giftCardId: number): Promise<void>;
}

export async function applyAcceptedCodes<T extends { id: number }>(
  deps: ApplyDeps<T>,
  codes: AcceptedCode[],
): Promise<{ created: T[]; skipped: { cardNumber: string; reason: string }[] }> {
  const already = new Set((await deps.existingNumbers()).map(normalizeCode));
  const created: T[] = [];
  const skipped: { cardNumber: string; reason: string }[] = [];

  for (const c of codes) {
    const cardNumber = stripWs(String(c.cardNumber ?? ''));
    if (!cardNumber) {
      skipped.push({ cardNumber: c.cardNumber, reason: 'empty' });
      continue;
    }
    if (already.has(normalizeCode(cardNumber))) {
      skipped.push({ cardNumber, reason: 'already on this order' });
      continue;
    }
    if (!c.merchant?.trim() || !(Number(c.value) > 0)) {
      skipped.push({ cardNumber, reason: 'merchant and a positive value are required' });
      continue;
    }

    // A source photo from another order (or a made-up id) is rejected outright
    // rather than silently saved unlinked: the client always sends the id of an
    // image it just analysed on this order, so a mismatch means a bad request.
    let attachment: { id: number; giftCardId: number | null } | null = null;
    if (c.attachmentId != null) {
      attachment = Number.isInteger(c.attachmentId) ? await deps.findAttachment(c.attachmentId) : null;
      if (!attachment) {
        skipped.push({ cardNumber, reason: 'photo does not belong to this order' });
        continue;
      }
    }

    // ocr_confirmed vs ocr_corrected is decided here, from what the user
    // submitted against what was suggested: the only real-world accuracy
    // signal this feature can produce. No suggestion at all means manual.
    const suggested = c.suggested ? normalizeCode(c.suggested) : '';
    const codeSource = !suggested
      ? 'manual'
      : suggested === normalizeCode(cardNumber) ? 'ocr_confirmed' : 'ocr_corrected';

    const card = await deps.createCard({
      merchant: c.merchant.trim(),
      value: Number(c.value),
      cardNumber,
      pin: c.pin ? stripWs(String(c.pin)) || null : null,
      codeSource,
      codeOcrAgreement: suggested ? (c.agreement ?? null) : null,
    });
    created.push(card);
    already.add(normalizeCode(cardNumber));
    // One photo links to one card: keep the first link if a photo yields several codes.
    if (attachment && attachment.giftCardId == null) {
      await deps.linkAttachment(attachment.id, card.id);
      attachment.giftCardId = card.id;
    }
  }
  return { created, skipped };
}
