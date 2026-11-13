// Sends a card's linked photos to CardCenter so they can sort out card errors
// (wrong code / balance). One file per upload, then ONE comment per
// reservation that references them all. Card codes appear ONLY as their last 4
// digits ("…1234") in comments, file names and logs; never log a PIN or bytes.
import { uploadCommentFile, postReservationComment, type CcAuth } from './cardcenter.ts';

export type ImagePhoto = { id: number; orderId: number; filename: string; originalName: string; mimeType: string; rotation: number };
export type ImageCard = {
  id: number;
  cardNumber: string;
  ccReservationId?: number | null;
  ccImagesSentAt: Date | null;
  photos: ImagePhoto[];
};

export interface ImageDeps {
  getSetting(userId: number | null, key: string): Promise<{ value: string } | null>;
  /** Cards of this user (scoped through the order), with their linked photos. */
  loadCards(userId: number | null, cardIds: number[]): Promise<ImageCard[]>;
  readPhoto(photo: ImagePhoto): Promise<Buffer>;
  toJpeg(bytes: Buffer, mimeType: string, rotation: number): Promise<Buffer>;
  markSent(cardIds: number[], at: Date): Promise<void>;
}

export type ImagesResult = {
  sent: number[];
  skippedNoPhoto: number[];
  alreadySent: number[];
  failed: number[];
  error?: string;
};

export const last4 = (code: string): string => (code.replace(/[^A-Za-z0-9]/g, '').slice(-4) || '????');
const tag = (code: string) => `…${last4(code)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function defaultDeps(): Promise<ImageDeps> {
  return (await import('./cardcenterImagesDeps.ts')).imageDeps;
}

export async function sendCardImages(
  auth: CcAuth,
  reservationId: number,
  cards: ImageCard[],
  opts: { force?: boolean } = {},
  deps?: ImageDeps,
): Promise<ImagesResult> {
  const d = deps ?? await defaultDeps();
  const result: ImagesResult = { sent: [], skippedNoPhoto: [], alreadySent: [], failed: [] };

  const todo: ImageCard[] = [];
  for (const c of cards) {
    if (!c.photos.length) result.skippedNoPhoto.push(c.id);
    else if (c.ccImagesSentAt && !opts.force) result.alreadySent.push(c.id);
    else todo.push(c);
  }
  if (!todo.length) return result;

  const uploaded: { card: ImageCard; ids: string[] }[] = [];
  for (const card of todo) {
    const ids: string[] = [];
    try {
      for (let i = 0; i < card.photos.length; i++) {
        const photo = card.photos[i];
        const jpeg = await d.toJpeg(await d.readPhoto(photo), photo.mimeType, photo.rotation);
        const filename = `card-${last4(card.cardNumber)}${i ? `-${i + 1}` : ''}.jpg`;
        ids.push((await uploadCommentFile(auth, { bytes: jpeg, filename, mimeType: 'image/jpeg' })).id);
      }
      uploaded.push({ card, ids });
    } catch (e) {
      result.failed.push(card.id);
      result.error = errText(e);
      console.warn(`[cardcenter-images] upload failed for ${tag(card.cardNumber)}: ${errText(e)}`);
    }
  }
  if (!uploaded.length) return result;

  try {
    const body = `Card images: ${uploaded.map(u => tag(u.card.cardNumber)).join(', ')}`;
    await postReservationComment(auth, reservationId, body, uploaded.flatMap(u => u.ids));
  } catch (e) {
    for (const u of uploaded) result.failed.push(u.card.id);
    result.error = errText(e);
    console.warn(`[cardcenter-images] comment failed on reservation ${reservationId}: ${errText(e)}`);
    return result;
  }

  const sentIds = uploaded.map(u => u.card.id);
  result.sent.push(...sentIds);
  try {
    await d.markSent(sentIds, new Date());
  } catch (e) {
    result.error = `sent but not recorded: ${errText(e)}`;
  }
  return result;
}

/** Loads the given cards, groups them by ccReservationId and sends each group. Never throws. */
export async function sendImagesForCards(
  userId: number | null,
  auth: CcAuth,
  cardIds: number[],
  opts: { force?: boolean } = {},
  deps?: ImageDeps,
): Promise<ImagesResult> {
  const total: ImagesResult = { sent: [], skippedNoPhoto: [], alreadySent: [], failed: [] };
  try {
    const d = deps ?? await defaultDeps();
    const cards = await d.loadCards(userId, cardIds);
    const byReservation = new Map<number, ImageCard[]>();
    for (const c of cards) {
      if (!c.ccReservationId) continue;
      const list = byReservation.get(c.ccReservationId) ?? [];
      list.push(c);
      byReservation.set(c.ccReservationId, list);
    }
    for (const [reservationId, group] of byReservation) {
      const r = await sendCardImages(auth, reservationId, group, opts, d);
      total.sent.push(...r.sent);
      total.skippedNoPhoto.push(...r.skippedNoPhoto);
      total.alreadySent.push(...r.alreadySent);
      total.failed.push(...r.failed);
      if (r.error) total.error = r.error;
    }
  } catch (e) {
    total.error = errText(e);
    console.warn(`[cardcenter-images] send failed: ${errText(e)}`);
  }
  return total;
}

/**
 * Post-submit hook for every submit path. Gated on the per-user `cc_send_images`
 * setting (ON unless explicitly 'false'). A failure here must never fail or roll
 * back the submit, so this never throws: errors come back in the result.
 */
export async function autoSendImages(
  userId: number | null,
  auth: CcAuth,
  cardIds: number[],
  deps?: ImageDeps,
): Promise<ImagesResult | { disabled: true }> {
  try {
    const d = deps ?? await defaultDeps();
    const setting = await d.getSetting(userId, 'cc_send_images');
    if (setting?.value === 'false') return { disabled: true };
    if (!cardIds.length) return { sent: [], skippedNoPhoto: [], alreadySent: [], failed: [] };
    return await sendImagesForCards(userId, auth, cardIds, {}, d);
  } catch (e) {
    console.warn(`[cardcenter-images] auto-send failed: ${errText(e)}`);
    return { sent: [], skippedNoPhoto: [], alreadySent: [], failed: [], error: errText(e) };
  }
}
