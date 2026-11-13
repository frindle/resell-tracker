// Sends a card's linked photos to CardCenter so they can sort out card errors
// (wrong code / balance). One file per upload, then ONE comment per
// reservation that references them all. Card codes appear ONLY as their last 4
// digits ("…1234") in comments, file names and logs; never log a PIN or bytes.
import { createHash } from 'node:crypto';
import { uploadCommentFile, postReservationComment, type CcAuth } from './cardcenter.ts';

export type ImagePhoto = { id: number; orderId: number; filename: string; originalName: string; mimeType: string; rotation: number; contentHash?: string | null };
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
  /** Photos already sent to this reservation (CcPhotoSend). */
  loadSent(reservationId: number): Promise<SentPhoto[]>;
  recordSent(rows: SentPhoto[]): Promise<void>;
  /** Remembers a photo's sha256 on the attachment. Best effort. */
  saveHash(attachmentId: number, hash: string): Promise<void>;
  /** Counts a failed send, so the backfill can stop retrying (BACKFILL_MAX_FAILS). */
  markFailed(cardIds: number[]): Promise<void>;
}

export type SentPhoto = {
  attachmentId: number;
  reservationId: number;
  ccFileId: string;
  filename: string;
  contentHash: string;
  /** "…1234,…5678": last 4 only. */
  cards: string;
};

export type ImagesResult = {
  sent: number[];
  skippedNoPhoto: number[];
  alreadySent: number[];
  failed: number[];
  /** Photos uploaded this call (one per distinct picture), with the cards each covers (last 4). */
  photos?: { attachmentId: number; filename: string; cards: string[] }[];
  photosUploaded?: number;
  /** Same picture saved as several attachments: sent once. */
  photosSkippedDup?: number;
  /** Already on this reservation from an earlier send. */
  photosAlreadySent?: number;
  error?: string;
};

export const last4 = (code: string): string => (code.replace(/[^A-Za-z0-9]/g, '').slice(-4) || '????');
const tag = (code: string) => `…${last4(code)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function countFailed(d: ImageDeps, ids: number[]): Promise<void> {
  if (!ids.length) return;
  try { await d.markFailed(ids); } catch (e) { console.warn(`[cardcenter-images] could not record failure: ${errText(e)}`); }
}

async function defaultDeps(): Promise<ImageDeps> {
  return (await import('./cardcenterImagesDeps.ts')).imageDeps;
}

type PhotoGroup = {
  members: ImagePhoto[];      // attachments with identical bytes
  rep: ImagePhoto;
  bytes: Buffer;
  hash: string;
  cards: ImageCard[];         // cards in this reservation group the picture covers
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Sends one reservation's cards. Deduped by PHOTO, not card: a picture showing
 * several cards is uploaded once, the same bytes saved twice go once, and a photo
 * already sent to this reservation is not sent again (later cards in it just get
 * a text line pointing at the earlier file). One comment per call.
 */
export async function sendCardImages(
  auth: CcAuth,
  reservationId: number,
  cards: ImageCard[],
  opts: { force?: boolean } = {},
  deps?: ImageDeps,
): Promise<ImagesResult> {
  const d = deps ?? await defaultDeps();
  const result: ImagesResult = { sent: [], skippedNoPhoto: [], alreadySent: [], failed: [], photos: [], photosUploaded: 0, photosSkippedDup: 0, photosAlreadySent: 0 };

  const todo: ImageCard[] = [];
  for (const c of cards) {
    if (!c.photos.length) result.skippedNoPhoto.push(c.id);
    else if (c.ccImagesSentAt && !opts.force) result.alreadySent.push(c.id);
    else todo.push(c);
  }
  if (!todo.length) return result;

  const failedIds = new Set<number>();
  const fail = (cs: ImageCard[], e: unknown, what: string) => {
    for (const c of cs) failedIds.add(c.id);
    result.error = errText(e);
    console.warn(`[cardcenter-images] ${what} for ${cs.map(c => tag(c.cardNumber)).join(', ')}: ${errText(e)}`);
  };

  // photo -> cards it covers (within this group)
  const byAttachment = new Map<number, { photo: ImagePhoto; cards: ImageCard[] }>();
  for (const c of todo) for (const p of c.photos) {
    const e = byAttachment.get(p.id) ?? { photo: p, cards: [] };
    if (!e.cards.includes(c)) e.cards.push(c);
    byAttachment.set(p.id, e);
  }

  // read + hash each photo, merge identical bytes
  const byHash = new Map<string, PhotoGroup>();
  for (const { photo, cards: cs } of byAttachment.values()) {
    try {
      const bytes = await d.readPhoto(photo);
      let hash = photo.contentHash;
      if (!hash) {
        hash = sha256(bytes);
        try { await d.saveHash(photo.id, hash); } catch { /* best effort */ }
      }
      const g = byHash.get(hash);
      if (g) {
        g.members.push(photo);
        for (const c of cs) if (!g.cards.includes(c)) g.cards.push(c);
        result.photosSkippedDup!++;
      } else {
        byHash.set(hash, { members: [photo], rep: photo, bytes, hash, cards: [...cs] });
      }
    } catch (e) {
      fail(cs, e, 'could not read photo');
    }
  }

  const sentRows = opts.force ? [] : await d.loadSent(reservationId);
  const earlier: { group: PhotoGroup; filename: string }[] = [];
  const fresh: PhotoGroup[] = [];
  for (const g of byHash.values()) {
    const prev = sentRows.find(r => r.contentHash === g.hash || g.members.some(m => m.id === r.attachmentId));
    if (prev) { earlier.push({ group: g, filename: prev.filename }); result.photosAlreadySent!++; }
    else fresh.push(g);
  }

  // upload each new picture once
  const used = new Set<string>();
  const uploaded: { group: PhotoGroup; fileId: string; filename: string }[] = [];
  for (const g of fresh) {
    const tags = [...new Set(g.cards.map(c => last4(c.cardNumber)))].sort();
    const base = tags.join('-');
    let filename = `${base}.jpg`;
    for (let n = 2; used.has(filename); n++) filename = `${base}-${n}.jpg`;
    used.add(filename);
    try {
      const jpeg = await d.toJpeg(g.bytes, g.rep.mimeType, g.rep.rotation);
      const { id } = await uploadCommentFile(auth, { bytes: jpeg, filename, mimeType: 'image/jpeg' });
      uploaded.push({ group: g, fileId: id, filename });
    } catch (e) {
      fail(g.cards, e, 'upload failed');
    }
  }

  const newCards: ImageCard[] = [];
  for (const u of uploaded) for (const c of u.group.cards) if (!newCards.includes(c)) newCards.push(c);
  const lines: string[] = [];
  const earlierOnly: ImageCard[] = [];
  for (const e of earlier) for (const c of e.group.cards) {
    if (newCards.includes(c) || earlierOnly.includes(c)) continue;
    earlierOnly.push(c);
    lines.push(`${tag(c.cardNumber)} is in ${e.filename} (sent earlier)`);
  }

  if (uploaded.length || lines.length) {
    const text = [
      ...(newCards.length ? [`Card images: ${newCards.map(c => tag(c.cardNumber)).join(', ')}`] : []),
      ...lines,
    ].join('\n');
    try {
      await postReservationComment(auth, reservationId, text, uploaded.map(u => u.fileId));
    } catch (e) {
      fail([...newCards, ...earlierOnly], e, `comment failed on reservation ${reservationId}`);
      await countFailed(d, [...failedIds]);
      result.failed.push(...failedIds);
      return result;
    }
  }

  // the comment succeeded: record what went where
  if (uploaded.length) {
    try {
      await d.recordSent(uploaded.flatMap(u => u.group.members.map(m => ({
        attachmentId: m.id,
        reservationId,
        ccFileId: u.fileId,
        filename: u.filename,
        contentHash: u.group.hash,
        cards: [...new Set(u.group.cards.map(c => tag(c.cardNumber)))].sort().join(','),
      }))));
    } catch (e) { result.error = `sent but not recorded: ${errText(e)}`; }
    result.photosUploaded = uploaded.length;
    result.photos = uploaded.map(u => ({ attachmentId: u.group.rep.id, filename: u.filename, cards: [...new Set(u.group.cards.map(c => tag(c.cardNumber)))].sort() }));
  }
  await countFailed(d, [...failedIds]);
  result.failed.push(...failedIds);
  const sentIds = [...newCards, ...earlierOnly].map(c => c.id).filter(id => !failedIds.has(id));
  result.sent.push(...sentIds);
  if (sentIds.length) {
    try { await d.markSent(sentIds, new Date()); } catch (e) { result.error = `sent but not recorded: ${errText(e)}`; }
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
      total.photos = [...(total.photos ?? []), ...(r.photos ?? [])];
      total.photosUploaded = (total.photosUploaded ?? 0) + (r.photosUploaded ?? 0);
      total.photosSkippedDup = (total.photosSkippedDup ?? 0) + (r.photosSkippedDup ?? 0);
      total.photosAlreadySent = (total.photosAlreadySent ?? 0) + (r.photosAlreadySent ?? 0);
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
