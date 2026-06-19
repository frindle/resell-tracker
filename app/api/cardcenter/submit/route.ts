import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, submitCards } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { orderId } = await req.json() as { orderId: number };

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured in Settings' }, { status: 400 });
    }

    const cards = await prisma.giftCard.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    if (!cards.length) return Response.json({ error: 'No gift cards on this order' }, { status: 400 });

    const unsubmitted = cards.filter(c => !c.ccSubmittedAt);
    if (!unsubmitted.length) {
      return Response.json({ submitted: 0, duplicate: 0, failed: 0, alreadyDone: true });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const result = await submitCards(token, unsubmitted.map(c => ({
      id: c.id,
      code: c.cardNumber,
      merchant: c.merchant,
      value: c.value,
      ccReservationId: c.ccReservationId,
    })));

    const doneIds = [...result.submitted, ...result.duplicate];
    if (doneIds.length) {
      await prisma.giftCard.updateMany({
        where: { id: { in: doneIds } },
        data: { ccSubmittedAt: new Date() },
      });
    }

    return Response.json({
      submitted: result.submitted.length,
      duplicate: result.duplicate.length,
      failed: result.failed.length,
      rawError: result.rawError,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
