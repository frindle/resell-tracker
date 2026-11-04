import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';

// Lists photos uploaded via bulk upload that haven't been sorted onto an
// order yet -- the queue /orders/sort-assign works through -- with what OCR
// matched each one to, if it has been scanned.
export async function GET(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const attachments = await prisma.orderAttachment.findMany({
    where: { orderId: null, userId: uid },
    orderBy: { createdAt: 'asc' },
    include: {
      uploadToken: { select: { name: true } },
      photoOcr: {
        select: { status: true, kind: true, strength: true, suggestedOrderId: true, giftCardId: true, alternatives: true, reason: true, error: true },
      },
    },
  });
  return Response.json({ attachments });
}
