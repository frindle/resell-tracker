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
import { isGiftCardOcrEnabled, readGiftCardImage } from '@/lib/giftCardOcr';
import { looksLikeReceipt } from '@/lib/giftCardOcrVerify';
import { matchPhoto, type MatchOrder } from '@/lib/photoMatch';
import { UNASSIGNED_DIR, moveAttachmentToOrder } from '@/lib/unassignedPhotos';

const ORDER_WINDOW_DAYS = 400;

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
    const ocr = await readGiftCardImage(bytes, { filename: att.originalName, contentType: att.mimeType });
    const texts = ocr.texts ?? [];
    const candidates = ocr.candidates.map(c => c.pin);

    const { orders, giftCards } = await loadMatchData(att.userId);
    const m = matchPhoto(
      { texts, candidates, looksLikeReceipt: looksLikeReceipt(texts), capturedAt: att.photoOcr?.capturedAt ?? att.createdAt },
      orders, giftCards,
    );

    await prisma.photoOcr.update({
      where: { attachmentId },
      data: {
        status: 'done', error: null, kind: m.kind,
        texts: JSON.stringify(texts), candidates: JSON.stringify(candidates), receipt: JSON.stringify(m.receipt),
        strength: m.strength, suggestedOrderId: m.orderId, giftCardId: m.giftCardId,
        alternatives: JSON.stringify(m.alternatives), reason: m.reason,
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
export async function enqueuePendingPhotos(uid: number, rescan = false): Promise<number> {
  if (!photoOcrEnabled()) return 0;
  const rows = await prisma.orderAttachment.findMany({
    where: {
      orderId: null, userId: uid, mimeType: { startsWith: 'image/' },
      ...(rescan ? {} : { OR: [{ photoOcr: null }, { photoOcr: { status: { in: ['pending', 'error'] } } }] }),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const r of rows) await enqueuePhotoOcr(r.id);
  return rows.length;
}
