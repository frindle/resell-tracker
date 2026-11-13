import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { linkOrderPhotos } from '@/lib/cardcenterImagesDeps';
import { enqueuePhotoOcr, photoOcrEnabled } from '@/lib/photoOcrRun';

// POST -- match this order's photos to its gift cards. Photos already read are
// linked now; photos never read (or whose read failed or was stopped) are queued
// for reading and linked when that finishes. Only adds links.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const unread = await prisma.orderAttachment.findMany({
    where: {
      orderId, mimeType: { startsWith: 'image/' },
      OR: [{ photoOcr: null }, { photoOcr: { status: { in: ['error', 'stopped'] } } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const ocrOn = photoOcrEnabled();
  if (ocrOn) for (const a of unread) await enqueuePhotoOcr(a.id);
  const linked = await linkOrderPhotos(orderId);
  const reading = await prisma.photoOcr.count({ where: { status: 'pending', attachment: { orderId } } });
  return Response.json({ linked, reading: ocrOn ? reading : 0, ocrOff: !ocrOn && unread.length > 0 });
}
