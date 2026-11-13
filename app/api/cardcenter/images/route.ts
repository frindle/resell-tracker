import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { sendImagesForCards } from '@/lib/cardcenterImages';
import { NextRequest } from 'next/server';

// POST /api/cardcenter/images
// Body: { orderId: number, giftCardIds?: number[], force?: boolean }
// Sends the photos linked to this order's submitted cards (those with a
// ccReservationId) to CardCenter. Cards already sent are skipped unless `force`.
export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { orderId, giftCardIds, force } = await req.json() as { orderId: number; giftCardIds?: number[]; force?: boolean };
    if (!Number.isInteger(orderId)) return Response.json({ error: 'orderId is required' }, { status: 400 });

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured in Settings' }, { status: 400 });
    }

    const cards = await prisma.giftCard.findMany({
      where: {
        orderId,
        order: { userId },
        ccSubmittedAt: { not: null },
        ccReservationId: { not: null },
        ...(Array.isArray(giftCardIds) ? { id: { in: giftCardIds } } : {}),
      },
      select: { id: true },
    });
    if (!cards.length) return Response.json({ error: 'No submitted cards with a reservation to send photos for' }, { status: 400 });

    const result = await sendImagesForCards(
      userId,
      { userId, email: emailSetting.value, password: passwordSetting.value },
      cards.map(c => c.id),
      { force: force === true },
    );
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
