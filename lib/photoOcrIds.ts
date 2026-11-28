// Checks the {ids} body of POST /api/photo-ocr/run. Pure, so the limits are
// tested without a request.
export const MAX_PHOTO_IDS = 50;

export type ParsedPhotoIds = { ok: true; ids: number[] } | { ok: false; error: string };

export function parsePhotoIds(value: unknown): ParsedPhotoIds {
  if (!Array.isArray(value)) return { ok: false, error: 'ids must be an array' };
  if (value.length < 1 || value.length > MAX_PHOTO_IDS) return { ok: false, error: `ids must have 1 to ${MAX_PHOTO_IDS} entries` };
  if (!value.every(v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) {
    return { ok: false, error: 'ids must be positive integers' };
  }
  // A repeated id is the same photo; queue it once.
  return { ok: true, ids: [...new Set(value as number[])] };
}
