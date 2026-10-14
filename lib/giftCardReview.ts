// eGift scraper cards whose title could not be parsed (or whose two titles
// disagreed) are stored as merchant 'eGift', value 0 and flagged with this
// codeSource. They are real codes but NOT complete: a person must set the
// merchant and value before the card may go anywhere that sends value on.
export const REVIEW_CODE_SOURCE = 'egift_scrape_review';
export const REVIEWED_CODE_SOURCE = 'egift_scrape';

export function isReviewCard(c: { codeSource?: string | null }): boolean {
  return c.codeSource === REVIEW_CODE_SOURCE;
}

/** Cards that may be submitted/reserved/waitlisted; review cards are held back. */
export function splitReview<T extends { codeSource?: string | null }>(cards: readonly T[]): { ok: T[]; held: T[] } {
  const ok: T[] = [];
  const held: T[] = [];
  for (const c of cards) (isReviewCard(c) ? held : ok).push(c);
  return { ok, held };
}

/**
 * codeSource a PATCH should leave on a card. A review card is released only
 * when the SAME edit supplies both a merchant and a value (> 0): that is a
 * person completing it, not an incidental PIN fix. Any other codeSource is
 * left exactly as it was (undefined = do not touch).
 */
export function codeSourceAfterEdit(current: string | null | undefined, edit: { merchant?: unknown; value?: unknown }): string | undefined {
  if (current !== REVIEW_CODE_SOURCE) return undefined;
  const merchantOk = typeof edit.merchant === 'string' && edit.merchant.trim() !== '';
  const valueOk = typeof edit.value === 'number' && edit.value > 0;
  return merchantOk && valueOk ? REVIEWED_CODE_SOURCE : undefined;
}
