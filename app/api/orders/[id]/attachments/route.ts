import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sniffUpload, uploadProblem } from '@/lib/uploadSniff';
import { sha256Hex } from '@/lib/unassignedPhotos';
import { enqueuePhotoOcr, photoOcrEnabled } from '@/lib/photoOcrRun';

const FILES_DIR = '/data/files';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);
  // Photos can be added to a locked order (removing them still needs it unlocked).

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return new Response('No file', { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const bad = uploadProblem(buffer);
  if (bad) return new Response(bad, { status: 400 });
  const type = sniffUpload(buffer)!;
  // The same photo dropped on this order twice is kept once.
  const contentSha256 = sha256Hex(buffer);
  const same = await prisma.orderAttachment.findFirst({ where: { orderId, contentSha256 } });
  if (same) return Response.json({ ...same, duplicate: true });

  const filename = `${randomUUID()}${type.ext}`;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  await writeFile(join(orderDir, filename), buffer);

  const attachment = await prisma.orderAttachment.create({
    data: { orderId, userId: userId ?? null, contentSha256, filename, originalName: file.name, mimeType: type.mime },
  });
  // Read it and link it to the order's gift cards whose codes it shows.
  // With photo reading off nothing is queued, so the photo doesn't sit at "reading…".
  if (type.mime.startsWith('image/') && photoOcrEnabled()) await enqueuePhotoOcr(attachment.id);

  return Response.json(attachment);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const attachments = await prisma.orderAttachment.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    include: {
      cardLinks: { select: { giftCardId: true } },
      ccSends: { select: { reservationId: true, filename: true, cards: true, sentAt: true } },
      photoOcr: { select: { status: true } },
    },
  });
  return Response.json(attachments.map(({ photoOcr, ...a }) => ({ ...a, ocrStatus: photoOcr?.status ?? null })));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);
  const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
  if (lockErr) return lockErr;
  const { attachmentId } = await req.json() as { attachmentId: number };

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const attachment = await prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId } });
  if (!attachment) return new Response('Not found', { status: 404 });

  try { await unlink(join(FILES_DIR, String(orderId), attachment.filename)); } catch { /* already gone */ }
  await prisma.orderAttachment.delete({ where: { id: attachmentId } });
  return Response.json({ ok: true });
}
