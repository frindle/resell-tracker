// Runs OCR on unassigned photos in the background and records which order
// each one points at (lib/photoMatch.ts).
//
// One photo at a time: OCR is seconds of CPU on a shared box. The queue is
// in-process, so a restart drops whatever was waiting; those rows stay
// 'pending' and the sort-assign page's "Scan photos" button (POST
// /api/photo-ocr/run) picks them up again.
//
// Auto-attach happens only for an 'exact' match and only when the user's
// `photo_auto_assign` setting is 'true'. Everything else is a suggestion.
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma, getSetting } from '@/lib/db';
import { isGiftCardOcrEnabled, orientGiftCardImage, readGiftCardImage } from '@/lib/giftCardOcr';
import { looksLikeReceipt } from '@/lib/giftCardOcrVerify';
import { matchPhoto, type MatchOrder } from '@/lib/photoMatch';
import { UNASSIGNED_DIR, moveAttachmentToOrder } from '@/lib/unassignedPhotos';
import { draftFromPhoto } from '@/lib/photoDraft';
import { loadDraftCtx } from '@/lib/photoDraftCtx';

const ORDER_WINDOW_DAYS = 400;

// The service's default ensemble (giftcard-ocr/engine.py DEFAULT_VARIANTS),
// turned. `rotation` is the clockwise display turn that makes the photo
// upright, the same value the rotate button saves.
const turned = (op: string) => [`${op}+redchan+stretch14`, `${op}+grayscale`];
const TURNS: Record<number, string[] | undefined> = {
  0: undefined, // the service's own default variants
  90: turned('rot90cw'),
  180: turned('rot180'),
  270: turned('rot90ccw'),
};
// Below this the classifier's call is a coin flip; read upright first instead.
const ORIENT_TRUST = 0.6;
// Without the classifier, a reading this poor is worth trying on its sides.
const SIDEWAYS_BELOW = 3;
// A receipt read this well is the right way up: another turn would only
// repeat a minutes-long read for nothing.
const READ_ENOUGH = 8;
// One read of a long receipt takes about two minutes on an idle box, and more
// while other photos are being read.
const READ_TIMEOUT_MS = 300_000;

const RANK = { exact: 3, likely: 2, ambiguous: 1, none: 0 } as const;
const WORDS = /\b(total|subtotal|costco|wholesale|activated|successful|gift|code|pin|receipt|purchased|items|visa|approved|thank|redeem|card|member)\b/i;

/** How readable a set of OCR lines is: known receipt/card words and long numbers. */
/**
 * Map line boxes read from a photo turned `rotation` degrees clockwise back
 * to the unturned photo, so a box stays right whatever rotation the user
 * later picks. Deduplicated by text (the variants mostly read the same lines).
 */
export function unturnBoxes(
  boxes: { text: string; box: [number, number, number, number] }[],
  rotation: number,
): { t: string; b: [number, number, number, number] }[] {
  const back = (x: number, y: number): [number, number] =>
    rotation === 90 ? [y, 1 - x] : rotation === 180 ? [1 - x, 1 - y] : rotation === 270 ? [1 - y, x] : [x, y];
  const seen = new Set<string>();
  const out: { t: string; b: [number, number, number, number] }[] = [];
  for (const { text, box } of boxes) {
    if (seen.has(text)) continue;
    seen.add(text);
    const [ax, ay] = back(box[0], box[1]);
    const [bx, by] = back(box[2], box[3]);
    const r = (n: number) => Math.round(n * 10000) / 10000;
    out.push({ t: text, b: [r(Math.min(ax, bx)), r(Math.min(ay, by)), r(Math.max(ax, bx)), r(Math.max(ay, by))] });
  }
  return out;
}

export function readability(texts: string[]): number {
  return texts.filter(t => WORDS.test(t) || /\d{8,}/.test(t.replace(/\s/g, ''))).length;
}

export function betterReading(
  a: { texts: string[]; match: { strength: keyof typeof RANK } },
  b: { texts: string[]; match: { strength: keyof typeof RANK } },
): boolean {
  const d = RANK[a.match.strength] - RANK[b.match.strength];
  if (d !== 0) return d > 0;
  return readability(a.texts) > readability(b.texts);
}

let chain: Promise<void> = Promise.resolve();
// Photo id -> ticket. A stopped photo loses its ticket, so its turn in the chain is skipped.
const queued = new Map<number, number>();
let nextTicket = 1;
let current: { id: number; since: number } | null = null;

/** What the photo reader is doing right now, for the sort page. */
export function photoOcrQueueStatus(): { waiting: number; current: { id: number; seconds: number } | null } {
  return {
    waiting: Math.max(0, queued.size - (current ? 1 : 0)),
    current: current ? { id: current.id, seconds: Math.round((Date.now() - current.since) / 1000) } : null,
  };
}

export function photoOcrEnabled(): boolean {
  return isGiftCardOcrEnabled();
}

/** Queue a photo for OCR + matching. With OCR off it only records the pending row. */
export async function enqueuePhotoOcr(attachmentId: number, capturedAt?: Date | null): Promise<void> {
  // The row is written even with OCR off, so the photo date is kept and the
  // photo is picked up by "Scan photos" once OCR is switched on.
  await prisma.photoOcr.upsert({
    where: { attachmentId },
    create: { attachmentId, status: 'pending', capturedAt: capturedAt ?? null },
    update: { status: 'pending', error: null, ...(capturedAt ? { capturedAt } : {}) },
  });
  if (!photoOcrEnabled() || queued.has(attachmentId)) return;
  const ticket = nextTicket++;
  queued.set(attachmentId, ticket);
  chain = chain
    .then(() => {
      if (queued.get(attachmentId) !== ticket) return; // stopped while waiting
      current = { id: attachmentId, since: Date.now() };
      return runPhotoOcr(attachmentId)
        .catch(err => console.error(`photo OCR ${attachmentId} failed:`, err))
        .finally(() => { if (queued.get(attachmentId) === ticket) queued.delete(attachmentId); current = null; });
    });
}

/**
 * Stop reading: every photo still waiting is taken off the queue. The photo being
 * read now finishes. Waiting photos that had an earlier reading keep it; the rest
 * are marked "stopped" and are picked up again by "Read new photos".
 */
export async function stopPhotoOcr(uid: number): Promise<number> {
  const waiting = [...queued.keys()].filter(id => id !== current?.id);
  if (!waiting.length) return 0;
  const mine = (await prisma.orderAttachment.findMany({
    where: { id: { in: waiting }, userId: uid }, select: { id: true },
  })).map(r => r.id);
  for (const id of mine) queued.delete(id);
  await prisma.photoOcr.updateMany({ where: { attachmentId: { in: mine }, status: 'pending', strength: { not: null } }, data: { status: 'done' } });
  await prisma.photoOcr.updateMany({ where: { attachmentId: { in: mine }, status: 'pending' }, data: { status: 'stopped' } });
  console.log(`[photo-ocr] stopped, ${mine.length} taken off the queue`);
  return mine.length;
}

async function loadMatchData(uid: number) {
  const since = new Date(Date.now() - ORDER_WINDOW_DAYS * 86_400_000);
  const [orders, giftCards] = await Promise.all([
    prisma.order.findMany({
      where: { userId: uid, orderDate: { gte: since } },
      select: {
        id: true, orderNumber: true, orderDate: true, cost: true, shippingCost: true,
        card: { select: { last4: true, lastFours: { select: { last4: true } } } },
        attachments: { select: { photoOcr: { select: { capturedAt: true } } } },
      },
    }),
    prisma.giftCard.findMany({
      where: { order: { userId: uid } },
      select: { id: true, orderId: true, cardNumber: true },
    }),
  ]);
  const matchOrders: MatchOrder[] = orders.map(o => ({
    id: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate, cost: o.cost, shippingCost: o.shippingCost,
    cardLast4s: [o.card?.last4, ...(o.card?.lastFours ?? []).map(l => l.last4)].filter((x): x is string => !!x),
    photoTimes: o.attachments.map(a => a.photoOcr?.capturedAt).filter((d): d is Date => !!d),
  }));
  return { orders: matchOrders, giftCards };
}

export async function runPhotoOcr(attachmentId: number): Promise<void> {
  const att = await prisma.orderAttachment.findUnique({ where: { id: attachmentId }, include: { photoOcr: true } });
  if (!att || att.orderId != null || att.userId == null) {
    // Already sorted (by hand) or gone: nothing to suggest.
    if (att?.photoOcr) await prisma.photoOcr.update({ where: { attachmentId }, data: { status: 'done' } });
    return;
  }
  if (!att.mimeType.startsWith('image/')) {
    await prisma.photoOcr.update({ where: { attachmentId }, data: { status: 'done', kind: 'unknown', strength: 'none', reason: 'Not an image' } });
    return;
  }

  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[photo-ocr] ${attachmentId} start (${queued.size} queued)`);
  try {
    const bytes = await readFile(join(UNASSIGNED_DIR, att.filename));
    const loaded = await loadMatchData(att.userId);
    // Orders the user already said this photo isn't are never suggested again.
    const rejected = new Set<number>((() => { try { return JSON.parse(att.photoOcr?.rejectedOrderIds ?? '[]') as number[]; } catch { return []; } })());
    const orders = loaded.orders.filter(o => !rejected.has(o.id));
    const giftCards = loaded.giftCards.filter(g => !rejected.has(g.orderId));
    const capturedAt = att.photoOcr?.capturedAt ?? att.createdAt;

    // The recogniser only reads upright text, and phone photos are often
    // taken upside down or sideways.
    const attempt = async (variants?: string[]) => {
      const ocr = await readGiftCardImage(bytes, { filename: att.originalName, contentType: att.mimeType, variants, timeoutMs: READ_TIMEOUT_MS });
      const texts = ocr.texts ?? [];
      const candidates = ocr.candidates.map(c => c.pin);
      const match = matchPhoto({ texts, candidates, looksLikeReceipt: looksLikeReceipt(texts), capturedAt, takenAt: att.photoOcr?.capturedAt ?? null }, orders, giftCards);
      return { texts, candidates, match, boxes: ocr.boxes ?? [] };
    };
    // Ask the orientation classifier which way the photo faces and read it
    // that way first. Then read upright and upside down too (the classifier
    // can confuse those two) and keep whichever matched best; a tie keeps the
    // first. With no classifier (older OCR service) and a poor reading, also
    // try both sides. Turned reads an older service rejects are skipped.
    const orient = await orientGiftCardImage(bytes, { filename: att.originalName, contentType: att.mimeType });
    const order = orient && orient.score >= ORIENT_TRUST ? [orient.rotation, 0, 180] : [0, 180];
    type Reading = Awaited<ReturnType<typeof attempt>> & { rotation: number };
    const tried = new Set<number>();
    const tryTurn = async (rotation: number, cur: Reading | null): Promise<Reading | null> => {
      if (tried.has(rotation) || cur?.match.strength === 'exact') return cur;
      if (cur && looksLikeReceipt(cur.texts) && readability(cur.texts) >= READ_ENOUGH) return cur;
      tried.add(rotation);
      // The first read must succeed; a later turned read may be rejected.
      const r = await (cur
        ? attempt(TURNS[rotation]).catch(err => {
          console.warn(`[photo-ocr] ${attachmentId} turned ${rotation} read skipped after ${secs()}s: ${String(err).slice(0, 200)}`);
          return null;
        })
        : attempt(TURNS[rotation]));
      return r && (!cur || betterReading(r, cur)) ? { ...r, rotation } : cur;
    };
    let found: Reading | null = null;
    for (const rot of order) found = await tryTurn(rot, found);
    if (!orient && found && readability(found.texts) < SIDEWAYS_BELOW) {
      for (const rot of [90, 270]) found = await tryTurn(rot, found);
    }
    if (!found) throw new Error('OCR read failed');
    const best: Reading = found;
    const { texts, candidates, match: m } = best;

    // Show the photo the way it reads. Only when the user hasn't turned it
    // themselves, and only on a reading with something recognisable in it.
    if (best.rotation !== 0 && att.rotation === 0 && readability(texts) > 0) {
      await prisma.orderAttachment.update({ where: { id: attachmentId }, data: { rotation: best.rotation } });
    }

    // Matched nothing: fill in a new order from the photo for the review
    // queue, unless the user already turned a draft for it down.
    // Set aside by hand in quick review: record the reading, suggest nothing.
    if (att.photoOcr?.manual) {
      await prisma.photoOcr.update({
        where: { attachmentId },
        data: {
          status: 'done', error: null, kind: m.kind, texts: JSON.stringify(texts),
          boxes: JSON.stringify(unturnBoxes(best.boxes, best.rotation)), candidates: JSON.stringify(candidates),
          strength: 'none', suggestedOrderId: null, giftCardId: null, alternatives: '[]', draft: null,
        },
      });
      return;
    }

    const draft = m.strength === 'none' && !att.photoOcr?.draftRejected
      // Boxes as read (upright), so rows and columns line up.
      ? draftFromPhoto({ kind: m.kind, texts, candidates, capturedAt, boxes: best.boxes }, await loadDraftCtx(att.userId))
      : null;

    await prisma.photoOcr.update({
      where: { attachmentId },
      data: {
        status: 'done', error: null, kind: m.kind,
        texts: JSON.stringify(texts), boxes: JSON.stringify(unturnBoxes(best.boxes, best.rotation)), candidates: JSON.stringify(candidates), receipt: JSON.stringify(m.receipt),
        strength: m.strength, suggestedOrderId: m.orderId, giftCardId: m.giftCardId,
        alternatives: JSON.stringify(m.alternatives),
        reason: draft ? `${m.reason}. A new order was filled in from this photo` : m.reason,
        draft: draft ? JSON.stringify(draft) : null,
      },
    });

    console.log(`[photo-ocr] ${attachmentId} done in ${secs()}s: ${m.kind}, ${m.strength}, turned ${best.rotation}, ${tried.size} reads`);

    if (m.strength === 'exact' && m.orderId != null) await autoAssign(attachmentId, att.userId, m.orderId, m.giftCardId);
  } catch (err) {
    console.error(`[photo-ocr] ${attachmentId} error after ${secs()}s: ${String(err).slice(0, 200)}`);
    await prisma.photoOcr.update({ where: { attachmentId }, data: { status: 'error', error: String(err).slice(0, 500) } });
  }
}

/** Attach a photo to its exactly-matched order, when the user switched that on. */
async function autoAssign(attachmentId: number, uid: number, orderId: number, giftCardId: number | null): Promise<void> {
  const auto = await getSetting(uid, 'photo_auto_assign');
  if (auto?.value !== 'true') return;
  const order = await prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true } });
  // Re-read: the user may have sorted it by hand while OCR ran.
  const still = await prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId: null } });
  if (order && still) {
    await moveAttachmentToOrder(still, orderId, giftCardId);
    await prisma.photoOcr.update({ where: { attachmentId }, data: { autoAssigned: true } });
  }
}

/**
 * Match photos that matched nothing again, from what was already read off
 * them (after a new order is created, the photos of its other cards point at
 * it). No OCR: a reading takes minutes, and the text hasn't changed. Returns
 * how many now point at an order.
 */
export async function rematchUnmatched(uid: number): Promise<number> {
  const rows = await prisma.photoOcr.findMany({
    where: { status: 'done', strength: 'none', manual: false, texts: { not: null }, attachment: { orderId: null, userId: uid } },
    select: { attachmentId: true, texts: true, candidates: true, capturedAt: true, rejectedOrderIds: true, attachment: { select: { createdAt: true } } },
  });
  if (!rows.length) return 0;
  const loaded = await loadMatchData(uid);
  const parse = <T>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
  let found = 0;
  for (const r of rows) {
    const texts = parse<string[]>(r.texts, []);
    const candidates = parse<string[]>(r.candidates, []);
    const rejected = new Set(parse<number[]>(r.rejectedOrderIds, []));
    const m = matchPhoto(
      { texts, candidates, looksLikeReceipt: looksLikeReceipt(texts), capturedAt: r.capturedAt ?? r.attachment.createdAt, takenAt: r.capturedAt ?? null },
      loaded.orders.filter(o => !rejected.has(o.id)),
      loaded.giftCards.filter(g => !rejected.has(g.orderId)),
    );
    if (m.strength === 'none') continue;
    found++;
    await prisma.photoOcr.update({
      where: { attachmentId: r.attachmentId },
      data: {
        kind: m.kind, receipt: JSON.stringify(m.receipt), strength: m.strength, suggestedOrderId: m.orderId,
        giftCardId: m.giftCardId, alternatives: JSON.stringify(m.alternatives), reason: m.reason, draft: null,
      },
    });
    if (m.strength === 'exact' && m.orderId != null) await autoAssign(r.attachmentId, uid, m.orderId, m.giftCardId);
  }
  console.log(`[photo-ocr] rematched ${rows.length} unmatched photos from their readings, ${found} now point at an order`);
  return found;
}

/** Queue every unassigned photo of this user that has no finished scan (or all, with rescan). */
export async function enqueuePendingPhotos(uid: number, rescan = false, unmatched = false): Promise<number> {
  if (!photoOcrEnabled()) return 0;
  // After a new order is created, photos that matched nothing get another
  // look: from their stored reading, or read again if they have none.
  if (unmatched && !rescan) await rematchUnmatched(uid);
  const rows = await prisma.orderAttachment.findMany({
    where: {
      orderId: null, userId: uid, mimeType: { startsWith: 'image/' },
      ...(rescan ? {} : {
        OR: [
          { photoOcr: null }, { photoOcr: { status: { in: ['pending', 'error', 'stopped'] } } },
          ...(unmatched ? [{ photoOcr: { status: 'done', strength: 'none', manual: false, texts: null } }] : []),
        ],
      }),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const r of rows) await enqueuePhotoOcr(r.id);
  return rows.length;
}

/** On boot: photos left "pending" by a restart are queued again (the queue lives in memory). */
export async function resumePendingPhotoOcr(): Promise<void> {
  if (!photoOcrEnabled()) return;
  const rows = await prisma.photoOcr.findMany({
    where: { status: 'pending', attachment: { orderId: null } },
    select: { attachmentId: true, attachment: { select: { createdAt: true } } },
    orderBy: { attachment: { createdAt: 'asc' } },
  });
  for (const r of rows) await enqueuePhotoOcr(r.attachmentId);
  if (rows.length) console.log(`[photo-ocr] resumed ${rows.length} photos left pending by a restart`);
}
