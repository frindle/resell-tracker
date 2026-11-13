// Picker write path: sets which of an order's gift cards a photo shows.
export interface PhotoCardDeps {
  orderCardIds(orderId: number): Promise<number[]>;
  /** Replaces the photo's link set and the legacy giftCardId (first id or null). */
  replace(attachmentId: number, ids: number[], first: number | null): Promise<void>;
}

export async function setAttachmentCards(
  deps: PhotoCardDeps,
  attachmentId: number,
  orderId: number,
  ids: unknown,
): Promise<{ ok: true; giftCardIds: number[] } | { ok: false; error: string }> {
  if (!Array.isArray(ids) || !ids.every(i => Number.isInteger(i))) return { ok: false, error: 'giftCardIds must be an array of integers' };
  const unique = [...new Set(ids as number[])];
  const onOrder = new Set(await deps.orderCardIds(orderId));
  if (unique.some(i => !onOrder.has(i))) return { ok: false, error: 'Gift card is not on this order' };
  await deps.replace(attachmentId, unique, unique.length ? unique[0] : null);
  return { ok: true, giftCardIds: unique };
}
