// Shared plumbing for the unassigned photo pool: saving an upload into it and
// moving a photo out of it onto an order. Used by bulk upload, the phone
// upload endpoint, the sort-assign PATCH and the OCR auto-match.
import { prisma } from '@/lib/db';
import { writeFile, mkdir, rename, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { makeUnrotatedThumbnail, unassignedThumbPath, UNASSIGNED_THUMB_DIR } from '@/lib/thumbnail';

export const FILES_DIR = '/data/files';
export const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * A photo this user already uploaded: same bytes, or the same sender photo id.
 * Looks at assigned photos too (userId stays set after assigning), so a photo
 * already sorted onto an order is not re-added to the pool either.
 */
export async function findDuplicatePhoto(uid: number, buffer: Buffer, sourceKey?: string | null) {
  const or: object[] = [{ contentSha256: sha256Hex(buffer) }];
  if (sourceKey) or.push({ sourceKey });
  return prisma.orderAttachment.findFirst({
    where: { userId: uid, OR: or },
    select: { id: true, originalName: true, orderId: true },
  });
}

export async function saveUnassignedPhoto(
  uid: number, buffer: Buffer, originalName: string, mimeType: string,
  from: { sourceKey?: string | null; uploadTokenId?: number | null } = {},
) {
  await mkdir(UNASSIGNED_DIR, { recursive: true });
  await mkdir(UNASSIGNED_THUMB_DIR, { recursive: true });
  const filename = `${randomUUID()}${extname(originalName) || ''}`;
  await writeFile(join(UNASSIGNED_DIR, filename), buffer);

  const attachment = await prisma.orderAttachment.create({
    data: {
      orderId: null, userId: uid, filename, originalName, mimeType: mimeType || 'application/octet-stream',
      contentSha256: sha256Hex(buffer), sourceKey: from.sourceKey || null, uploadTokenId: from.uploadTokenId ?? null,
    },
  });

  // Cached unrotated thumbnail for the triage grid; a failure must not fail
  // the upload (the read path regenerates from the original).
  if (attachment.mimeType.startsWith('image/')) {
    try {
      await writeFile(unassignedThumbPath(filename), await makeUnrotatedThumbnail(buffer, attachment.mimeType));
    } catch (err) {
      console.error(`thumbnail generation failed for ${filename}:`, err);
    }
  }
  return attachment;
}

// Moves the file into the order's folder (attachment routes build the path
// from orderId + filename) and points the row at the order. Callers do the
// ownership and order-lock checks first.
export async function moveAttachmentToOrder(
  attachment: { id: number; filename: string },
  orderId: number,
  giftCardId?: number | null,
) {
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  await rename(join(UNASSIGNED_DIR, attachment.filename), join(orderDir, attachment.filename));
  // The cached thumbnail only serves the unassigned grid.
  try { await unlink(unassignedThumbPath(attachment.filename)); } catch { /* already gone */ }
  return prisma.orderAttachment.update({
    where: { id: attachment.id },
    data: { orderId, ...(giftCardId ? { giftCardId } : {}) },
  });
}
