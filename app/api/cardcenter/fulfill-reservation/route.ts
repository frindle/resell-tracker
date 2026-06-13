import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// POST /api/cardcenter/fulfill-reservation
// Body: { reservationId: number, cardIds: number[] }
// Submits card codes against an existing approved reservation.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { reservationId, cardIds } = await req.json() as { reservationId: number; cardIds: number[] };

  if (!reservationId || !cardIds?.length) {
    return Response.json({ error: 'reservationId and cardIds are required' }, { status: 400 });
  }

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
  }

  const cards = await prisma.giftCard.findMany({
    where: { id: { in: cardIds }, order: { userId } },
    select: { id: true, cardNumber: true, orderId: true },
  });
  if (cards.length !== cardIds.length) {
    return Response.json({ error: 'Invalid card IDs' }, { status: 403 });
  }

  const orderId = cards[0].orderId;
  const lockError = await requireOrderUnlocked(orderId, userId);
  if (lockError) return lockError;

  const token = await getCcToken(emailSetting.value, passwordSetting.value);

  await prisma.giftCard.updateMany({
    where: { id: { in: cardIds } },
    data: { ccReservationId: reservationId },
  });

  const codes = cards.map(c => c.cardNumber).join('\n');
  const parseRes = await fetch(`${BASE_URL}/Api/Reservations/${reservationId}/ParsedCards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: codes }),
  });
  if (!parseRes.ok) {
    const text = await parseRes.text().catch(() => String(parseRes.status));
    return Response.json({ error: `ParsedCards failed: ${text}` }, { status: 502 });
  }
  const parsed = await parseRes.json() as { submission: { groups: unknown[] } };

  const reservationDetailRes = await fetch(`${BASE_URL}/Api/Reservations/${reservationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!reservationDetailRes.ok) {
    return Response.json({ error: 'Could not fetch reservation detail' }, { status: 502 });
  }
  const reservationDetail = await reservationDetailRes.json() as { seller: { id: number; email: string } };

  const submitRes = await fetch(`${BASE_URL}/Api/Submissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ seller: reservationDetail.seller, groups: parsed.submission.groups }),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => String(submitRes.status));
    return Response.json({ error: `Submission failed: ${text}` }, { status: 502 });
  }

  await prisma.giftCard.updateMany({
    where: { id: { in: cardIds } },
    data: { ccSubmittedAt: new Date() },
  });

  let overdueAt: Date | null = null;
  try {
    await new Promise(r => setTimeout(r, 5000));
    const paymentsRes = await fetch(
      `${BASE_URL}/Api/Payments?paidTo=${reservationDetail.seller.id}&status=Scheduled`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (paymentsRes.ok) {
      const paymentsData = await paymentsRes.json() as { items?: Array<{ receivedOn: string; date: string }> };
      const latest = (paymentsData.items ?? []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
      if (latest?.receivedOn) overdueAt = new Date(latest.receivedOn);
    }
  } catch { /* non-fatal */ }

  if (overdueAt) {
    await prisma.order.update({ where: { id: orderId }, data: { overdueAt } });
  }

  return Response.json({ submitted: cardIds.length, overdueAt: overdueAt?.toISOString() ?? null });
}
