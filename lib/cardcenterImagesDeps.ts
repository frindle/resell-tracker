// Real dependencies (DB, disk, sharp) for lib/cardcenterImages.ts. Kept apart so
// the sending logic can be unit-tested without prisma or sharp.
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma, getSetting } from '@/lib/db';
import { makeUploadJpeg } from '@/lib/thumbnail';
import type { ImageDeps, ImageCard } from './cardcenterImages.ts';
import type { BackfillDeps } from './cardcenterImagesBackfill.ts';

const FILES_DIR = '/data/files';

const cardSelect = {
  id: true, cardNumber: true, ccReservationId: true, ccImagesSentAt: true,
  attachments: {
    where: { orderId: { not: null } },
    orderBy: { createdAt: 'asc' as const },
    select: { id: true, orderId: true, filename: true, originalName: true, mimeType: true, rotation: true },
  },
};

async function loadCardsWhere(where: NonNullable<Parameters<typeof prisma.giftCard.findMany>[0]>['where']): Promise<ImageCard[]> {
  const rows = await prisma.giftCard.findMany({ where, select: cardSelect, orderBy: { id: 'asc' } });
  return rows.map(({ attachments, ...c }) => ({
    ...c,
    photos: attachments
      .filter(a => a.mimeType.startsWith('image/'))
      .map(a => ({ ...a, orderId: a.orderId as number })),
  }));
}

export const imageDeps: ImageDeps = {
  getSetting: (userId, key) => getSetting(userId, key),
  loadCards: (userId, cardIds) => loadCardsWhere({ id: { in: cardIds }, order: { userId } }),
  readPhoto: p => readFile(join(FILES_DIR, String(p.orderId), p.filename)),
  toJpeg: (bytes, mimeType, rotation) => makeUploadJpeg(bytes, mimeType, rotation),
  async markSent(cardIds, at) {
    await prisma.giftCard.updateMany({ where: { id: { in: cardIds } }, data: { ccImagesSentAt: at } });
  },
};

const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

export const backfillDeps: BackfillDeps = {
  ...imageDeps,
  async listUnlinkedPhotos(userId) {
    const rows = await prisma.photoOcr.findMany({
      where: { kind: 'gift_card', attachment: { giftCardId: null, order: { userId } } },
      select: { attachmentId: true, kind: true, giftCardId: true, candidates: true, texts: true, attachment: { select: { orderId: true } } },
    });
    return rows.filter(r => r.attachment.orderId != null).map(r => ({
      attachmentId: r.attachmentId,
      orderId: r.attachment.orderId as number,
      kind: r.kind,
      ocrGiftCardId: r.giftCardId,
      candidates: parseList(r.candidates),
      texts: parseList(r.texts),
    }));
  },
  listOrderCards: orderIds => prisma.giftCard.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, cardNumber: true } }),
  async linkPhoto(attachmentId, giftCardId) {
    // giftCardId: null in the WHERE keeps this from ever overwriting an existing link.
    await prisma.orderAttachment.updateMany({ where: { id: attachmentId, giftCardId: null }, data: { giftCardId } });
  },
  listBackfillCards: userId => loadCardsWhere({
    ccSubmittedAt: { not: null }, ccReservationId: { not: null }, ccImagesSentAt: null, order: { userId },
  }),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

export async function usersWithCardCenter(): Promise<number[]> {
  const rows = await prisma.setting.findMany({ where: { key: 'cc_email' }, select: { userId: true } });
  return rows.map(r => r.userId).filter((u): u is number => u != null);
}
