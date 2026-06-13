import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// POST /api/cardcenter/reserve
// Body: { buyOrderId: number, quantity: number, cardIds: number[] }
// Creates a reservation then immediately submits the card codes against it.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { buyOrderId, quantity, cardIds } = await req.json() as {
    buyOrderId: number;
    quantity: number;
    cardIds: number[];
  };

  if (!buyOrderId || !quantity || !cardIds?.length) {
    return Response.json({ error: 'buyOrderId, quantity, and cardIds are required' }, { status: 400 });
  }

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
  }

  // Verify all cards belong to this user and get their codes
  const cards = await prisma.giftCard.findMany({
    where: { id: { in: cardIds }, order: { userId } },
    select: { id: true, cardNumber: true, orderId: true },
  });
  if (cards.length !== cardIds.length) {
    return Response.json({ error: 'Invalid card IDs' }, { status: 403 });
  }

  const token = await getCcToken(emailSetting.value, passwordSetting.value);

  // Create reservation via ReserveCap
  const reserveRes = await fetch(`${BASE_URL}/Api/Rates/${buyOrderId}/Actions/ReserveCap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantity }),
  });
  if (!reserveRes.ok) {
    const text = await reserveRes.text().catch(() => String(reserveRes.status));
    return Response.json({ error: `ReserveCap failed: ${text}` }, { status: 502 });
  }

  const submission = await reserveRes.json() as {
    id: string;
    groups: Array<{ reservation: { id: number; status: string; submissionDeadline?: string; submissionToken?: string } }>;
  };

  const submissionId = submission.id;

  // Poll until reservation is Approved (up to 30s)
  let reservation = submission.groups?.[0]?.reservation;
  const deadline = Date.now() + 30000;
  while (reservation?.status === 'Processing' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await fetch(`${BASE_URL}/Api/Submissions/${submissionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (pollRes.ok) {
      const data = await pollRes.json() as typeof submission;
      reservation = data.groups?.[0]?.reservation;
    }
  }

  if (reservation?.status !== 'Approved') {
    return Response.json({ error: `Reservation did not approve in time (status: ${reservation?.status ?? 'unknown'})` }, { status: 504 });
  }

  // Save reservation info to all gift cards in this group
  await prisma.giftCard.updateMany({
    where: { id: { in: cardIds } },
    data: { ccReservationId: reservation.id, ccSubmissionId: submissionId },
  });

  // Submit card codes immediately against the approved reservation
  const codes = cards.map(c => c.cardNumber).join('\n');

  const parseRes = await fetch(`${BASE_URL}/Api/Reservations/${reservation.id}/ParsedCards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: codes }),
  });

  if (!parseRes.ok) {
    const text = await parseRes.text().catch(() => String(parseRes.status));
    return Response.json({
      reservationId: reservation.id,
      submissionDeadline: reservation.submissionDeadline,
      submitError: `ParsedCards failed: ${text}`,
    });
  }

  const parsed = await parseRes.json() as { submission: { groups: unknown[] } };

  // Fetch full reservation for seller info
  const reservationDetailRes = await fetch(`${BASE_URL}/Api/Reservations/${reservation.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const reservationDetail = reservationDetailRes.ok
    ? await reservationDetailRes.json() as { seller: { id: number; email: string } }
    : null;

  if (!reservationDetail) {
    return Response.json({
      reservationId: reservation.id,
      submissionDeadline: reservation.submissionDeadline,
      submitError: 'Could not fetch reservation detail for seller info',
    });
  }

  const submitRes = await fetch(`${BASE_URL}/Api/Submissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ seller: reservationDetail.seller, groups: parsed.submission.groups }),
  });

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => String(submitRes.status));
    return Response.json({
      reservationId: reservation.id,
      submissionDeadline: reservation.submissionDeadline,
      submitError: `Submission failed: ${text}`,
    });
  }

  // Mark cards as submitted
  await prisma.giftCard.updateMany({
    where: { id: { in: cardIds } },
    data: { ccSubmittedAt: new Date() },
  });

  // Fetch the scheduled payment to get the exact due date from CardCenter
  let overdueAt: Date | null = null;
  try {
    const sellerId = reservationDetail.seller.id;
    const paymentsRes = await fetch(
      `${BASE_URL}/Api/Payments?paidTo=${sellerId}&status=Scheduled`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (paymentsRes.ok) {
      const paymentsData = await paymentsRes.json() as { items?: Array<{ receivedOn: string; date: string }> };
      const items = paymentsData.items ?? [];
      // Most recently created payment is the one we just triggered
      const latest = items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
      if (latest?.receivedOn) overdueAt = new Date(latest.receivedOn);
    }
  } catch { /* non-fatal — proceed without due date */ }

  const orderId = cards[0].orderId;
  if (overdueAt) {
    await prisma.order.update({ where: { id: orderId }, data: { overdueAt } });
  }

  return Response.json({
    reservationId: reservation.id,
    submissionDeadline: reservation.submissionDeadline,
    submitted: cardIds.length,
    overdueAt: overdueAt?.toISOString() ?? null,
  });
}
