import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const userId = await getSessionUserId();
  const { id, attachmentId } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const attachment = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId },
  });
  if (!attachment) return new Response('Not found', { status: 404 });

  try {
    const buffer = await readFile(join(FILES_DIR, String(orderId), attachment.filename));
    return new Response(buffer, {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Disposition': `inline; filename="${attachment.originalName}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new Response('File not found', { status: 404 });
  }
}
