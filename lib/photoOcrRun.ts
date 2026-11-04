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

const RANK = { exact: 3, likely: 2, ambiguous: 1, none: 0 } as const;
const WORDS = /\b(total|subtotal|costco|wholesale|activated|successful|gift|code|pin|receipt|purchased|items|visa|approved|thank|redeem|card|member)\b/i;

/** How readable a set of OCR lines is: known receipt/card words and long numbers. */
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
const queued = new Set<number>();

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
  queued.add(attachmentId);
  chain = chain
    .then(() => runPhotoOcr(attachmentId))
    .catch(err => console.error(`photo OCR ${attachmentId} failed:`, err))
    .finally(() => { queued.delete(attachmentId); });
}

async function loadMatchData(uid: number) {
  const since = new Date(Date.now() - ORDER_WINDOW_DAYS * 86_400_000);
  const [orders, giftCards] = await Promise.all([
    prisma.order.findMany({
      where: { userId: uid, orderDate: { gte: since } },
      select: {
        id: true, orderNumber: true, orderDate: true, cost: true, shippingCost: true,
        card: { select: { last4: true, lastFours: { select: { last4: true } } } },
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
      const ocr = await readGiftCardImage(bytes, { filename: att.originalName, contentType: att.mimeType, variants });
      const texts = ocr.texts ?? [];
      const candidates = ocr.candidates.map(c => c.pin);
      const match = matchPhoto({ texts, candidates, looksLikeReceipt: looksLikeReceipt(texts), capturedAt }, orders, giftCards);
      return { texts, candidates, match };
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
      tried.add(rotation);
      // The first read must succeed; a later turned read may be rejected.
      const r = await (cur ? attempt(TURNS[rotation]).catch(() => null) : attempt(TURNS[rotation]));
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
    const draft = m.strength === 'none' && !att.photoOcr?.draftRejected
      ? draftFromPhoto({ kind: m.kind, texts, candidates, capturedAt }, await loadDraftCtx(att.userId))
      : null;

    await prisma.photoOcr.update({
      where: { attachmentId },
      data: {
        status: 'done', error: null, kind: m.kind,
        texts: JSON.stringify(texts), candidates: JSON.stringify(candidates), receipt: JSON.stringify(m.receipt),
        strength: m.strength, suggestedOrderId: m.orderId, giftCardId: m.giftCardId,
        alternatives: JSON.stringify(m.alternatives),
        reason: draft ? `${m.reason}. A new order was filled in from this photo` : m.reason,
        draft: draft ? JSON.stringify(draft) : null,
      },
    });

    if (m.strength === 'exact' && m.orderId != null) {
      const auto = await getSetting(att.userId, 'photo_auto_assign');
      if (auto?.value === 'true') {
        const order = await prisma.order.findFirst({ where: { id: m.orderId, userId: att.userId }, select: { locked: true } });
        // Re-read: the user may have sorted it by hand while OCR ran.
        const still = await prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId: null } });
        if (order && !order.locked && still) {
          await moveAttachmentToOrder(still, m.orderId, m.giftCardId);
          await prisma.photoOcr.update({ where: { attachmentId }, data: { autoAssigned: true } });
        }
      }
    }
  } catch (err) {
    await prisma.photoOcr.update({ where: { attachmentId }, data: { status: 'error', error: String(err).slice(0, 500) } });
  }
}

/** Queue every unassigned photo of this user that has no finished scan (or all, with rescan). */
export async function enqueuePendingPhotos(uid: number, rescan = false, unmatched = false): Promise<number> {
  if (!photoOcrEnabled()) return 0;
  const rows = await prisma.orderAttachment.findMany({
    where: {
      orderId: null, userId: uid, mimeType: { startsWith: 'image/' },
      ...(rescan ? {} : {
        OR: [
          { photoOcr: null }, { photoOcr: { status: { in: ['pending', 'error'] } } },
          // After a new order is created, photos that matched nothing get another look.
          ...(unmatched ? [{ photoOcr: { status: 'done', strength: 'none' } }] : []),
        ],
      }),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const r of rows) await enqueuePhotoOcr(r.id);
  return rows.length;
}
