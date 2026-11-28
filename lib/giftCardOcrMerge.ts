/**
 * Folds the answer of a one-photo re-read (GET /api/giftcard-ocr/orders/[id]
 * ?attachment=<id>) into the analysis of the full read. Only that photo's image
 * and suggestions change; the verification stays as the full read made it,
 * because it was worked out from every photo.
 *
 * Generic so it stays a pure function of the fields it touches.
 */
export function mergeRereadImage<
  A extends { images: { attachmentId: number }[]; suggestions: { attachmentId: number; pin: string }[] },
>(prev: A, one: { images: A['images']; suggestions: A['suggestions'] }): A {
  const img = one.images[0];
  if (!img) return prev;
  const id = img.attachmentId;

  const known = prev.images.some(i => i.attachmentId === id);
  // An id the analysis has not seen is added rather than lost.
  const images = known ? prev.images.map(i => (i.attachmentId === id ? img : i)) : [...prev.images, img];

  const kept = prev.suggestions.filter(s => s.attachmentId !== id);
  // A pin already suggested from another photo stays with that photo.
  const taken = new Set(kept.map(s => s.pin));
  const added = one.suggestions.filter(s => {
    if (s.attachmentId !== id || taken.has(s.pin)) return false;
    taken.add(s.pin);
    return true;
  });

  return { ...prev, images, suggestions: [...kept, ...added] } as A;
}
