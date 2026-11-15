// Real dependencies (DB, disk, sharp) for lib/cardcenterImages.ts. Kept apart so
// the sending logic can be unit-tested without prisma or sharp.
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma, getSetting } from '@/lib/db';
import { makeUploadJpeg } from '@/lib/thumbnail';
import type { ImageDeps, ImageCard } from './cardcenterImages.ts';
import { BACKFILL_MAX_FAILS, planLinks, type BackfillDeps, type UnlinkedPhoto } from './cardcenterImagesBackfill.ts';
import { planReceiptLinks } from './receiptCards.ts';

const FILES_DIR = '/data/files';

const attSelect = { id: true, orderId: true, filename: true, originalName: true, mimeType: true, rotation: true, contentHash: true, createdAt: true, receipt: true };
const cardSelect = {
  id: true, cardNumber: true, ccReservationId: true, ccImagesSentAt: true,
  attachments: { where: { orderId: { not: null } }, select: attSelect },
  photoLinks: { select: { attachment: { select: attSelect } } },
};

async function loadCardsWhere(where: NonNullable<Parameters<typeof prisma.giftCard.findMany>[0]>['where']): Promise<ImageCard[]> {
  const rows = await prisma.giftCard.findMany({ where, select: cardSelect, orderBy: { id: 'asc' } });
  return rows.map(({ attachments, photoLinks, ...c }) => {
    // union of the legacy single link and the many-to-many links, one entry per attachment
    const byId = new Map<number, (typeof attachments)[number]>();
    for (const a of attachments) byId.set(a.id, a);
    for (const l of photoLinks) if (l.attachment.orderId != null) byId.set(l.attachment.id, l.attachment);
    // Receipts are linked to the cards they cover but never sent: they carry
    // the member number and payment card.
    const photos = [...byId.values()]
      .filter(a => a.mimeType.startsWith('image/') && a.receipt !== true)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id - y.id)
      .map(({ createdAt: _c, receipt: _r, ...a }) => ({ ...a, orderId: a.orderId as number }));
    return { ...c, photos };
  });
}

/** Insert-if-missing link; also fills the legacy giftCardId when it is empty. Never removes a link. */
export async function linkPhotoToCard(attachmentId: number, giftCardId: number): Promise<void> {
  await prisma.giftCardPhoto.upsert({
    where: { giftCardId_attachmentId: { giftCardId, attachmentId } },
    create: { giftCardId, attachmentId },
    update: {},
  });
  await prisma.orderAttachment.updateMany({ where: { id: attachmentId, giftCardId: null }, data: { giftCardId } });
}

export const imageDeps: ImageDeps = {
  getSetting: (userId, key) => getSetting(userId, key),
  loadCards: (userId, cardIds) => loadCardsWhere({ id: { in: cardIds }, order: { userId } }),
  readPhoto: p => readFile(join(FILES_DIR, String(p.orderId), p.filename)),
  toJpeg: (bytes, mimeType, rotation) => makeUploadJpeg(bytes, mimeType, rotation),
  async markSent(cardIds, at) {
    await prisma.giftCard.updateMany({ where: { id: { in: cardIds } }, data: { ccImagesSentAt: at } });
  },
  async loadSent(reservationId) {
    const rows = await prisma.ccPhotoSend.findMany({ where: { reservationId } });
    return rows.map(r => ({ attachmentId: r.attachmentId, reservationId: r.reservationId, ccFileId: r.ccFileId, filename: r.filename, contentHash: r.contentHash, cards: r.cards }));
  },
  async recordSent(rows) {
    for (const r of rows) {
      await prisma.ccPhotoSend.upsert({
        where: { attachmentId_reservationId: { attachmentId: r.attachmentId, reservationId: r.reservationId } },
        create: r,
        update: { ccFileId: r.ccFileId, filename: r.filename, contentHash: r.contentHash, cards: r.cards, sentAt: new Date() },
      });
    }
  },
  async saveHash(attachmentId, hash) {
    await prisma.orderAttachment.update({ where: { id: attachmentId }, data: { contentHash: hash } });
  },
  async markFailed(cardIds) {
    await prisma.giftCard.updateMany({ where: { id: { in: cardIds } }, data: { ccImagesFails: { increment: 1 } } });
  },
};

const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

/**
 * Gift-card photos on orders that have a reading (PhotoOcr row), with what was
 * read and the cards each is already linked to. `where` narrows the PhotoOcr rows.
 */
export async function listReadPhotos(where: NonNullable<Parameters<typeof prisma.photoOcr.findMany>[0]>['where']): Promise<UnlinkedPhoto[]> {
  const rows = await prisma.photoOcr.findMany({
    // Read as a gift card photo, or marked one by hand; never a receipt.
    where: { AND: [{ OR: [{ kind: 'gift_card', attachment: { receipt: null } }, { attachment: { receipt: false } }] }, where ?? {}] },
    select: {
      attachmentId: true, kind: true, giftCardId: true, candidates: true, texts: true,
      attachment: { select: { orderId: true, giftCardId: true, receipt: true, cardLinks: { select: { giftCardId: true } } } },
    },
  });
  return rows.filter(r => r.attachment.orderId != null).map(r => ({
    attachmentId: r.attachmentId,
    orderId: r.attachment.orderId as number,
    kind: r.kind,
    ocrGiftCardId: r.giftCardId,
    candidates: parseList(r.candidates),
    texts: parseList(r.texts),
    linkedCardIds: [...new Set([...(r.attachment.giftCardId != null ? [r.attachment.giftCardId] : []), ...r.attachment.cardLinks.map(l => l.giftCardId)])],
    receipt: r.attachment.receipt,
  }));
}

/**
 * Links an order's read photos to the order's cards: gift-card photos to the
 * cards whose codes they show (exact match, lib/cardcenterImagesBackfill.ts
 * planLinks), receipts to the cards whose merchant they name
 * (lib/receiptCards.ts). Only adds links, never removes one the owner set.
 * Returns how many links were added.
 */
export async function linkOrderPhotos(orderId: number): Promise<number> {
  const cards = await prisma.giftCard.findMany({ where: { orderId }, select: { id: true, orderId: true, cardNumber: true, merchant: true } });
  if (!cards.length) return 0;
  const plan = planLinks(await listReadPhotos({ attachment: { orderId } }), cards);
  for (const l of plan.links) await linkPhotoToCard(l.attachmentId, l.cardId);

  const rows = await prisma.photoOcr.findMany({
    where: { status: 'done', attachment: { orderId }, OR: [{ kind: 'receipt' }, { attachment: { receipt: true } }] },
    select: { attachmentId: true, kind: true, texts: true, candidates: true, attachment: { select: { receipt: true, giftCardId: true, cardLinks: { select: { giftCardId: true } } } } },
  });
  const rplan = planReceiptLinks(rows.map(r => ({
    attachmentId: r.attachmentId,
    receipt: r.attachment.receipt,
    kind: r.kind,
    texts: parseList(r.texts),
    candidates: parseList(r.candidates),
    linkedCardIds: [...(r.attachment.giftCardId != null ? [r.attachment.giftCardId] : []), ...r.attachment.cardLinks.map(l => l.giftCardId)],
  })), cards);
  // Marked before linking, so a send never sees a receipt as a card photo.
  if (rplan.markReceipt.length) await prisma.orderAttachment.updateMany({ where: { id: { in: rplan.markReceipt }, receipt: null }, data: { receipt: true } });
  for (const l of rplan.links) await linkPhotoToCard(l.attachmentId, l.cardId);

  const n = plan.links.length + rplan.links.length;
  if (n) console.log(`[photo-links] order ${orderId}: linked ${plan.links.length} photo-card and ${rplan.links.length} receipt-card pair(s)`);
  return n;
}

export const backfillDeps: BackfillDeps = {
  ...imageDeps,
  listUnlinkedPhotos: userId => listReadPhotos({ attachment: { order: { userId } } }),
  listOrderCards: orderIds => prisma.giftCard.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, cardNumber: true } }),
  linkPhoto: (attachmentId, giftCardId) => linkPhotoToCard(attachmentId, giftCardId),
  listBackfillCards: userId => loadCardsWhere({
    ccSubmittedAt: { not: null }, ccReservationId: { not: null }, ccImagesSentAt: null, ccImagesFails: { lt: BACKFILL_MAX_FAILS }, order: { userId },
  }),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

export async function usersWithCardCenter(): Promise<number[]> {
  const rows = await prisma.setting.findMany({ where: { key: 'cc_email' }, select: { userId: true } });
  return rows.map(r => r.userId).filter((u): u is number => u != null);
}
