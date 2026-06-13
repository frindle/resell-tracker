import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';

const FILES_DIR = '/data/files';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);
  const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
  if (lockErr) return lockErr;

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return new Response('No file', { status: 400 });

  const ext = extname(file.name) || '';
  const filename = `${randomUUID()}${ext}`;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(join(orderDir, filename), buffer);

  const attachment = await prisma.orderAttachment.create({
    data: { orderId, filename, originalName: file.name, mimeType: file.type || 'application/octet-stream' },
  });

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
  });
  return Response.json(attachments);
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
