import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// POST /api/cardcenter/reserve-only
// Body: { buyOrderId: number, quantity: number }
// Creates a reservation without submitting any cards — used from the Rates page.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { buyOrderId, quantity } = await req.json() as { buyOrderId: number; quantity: number };

  if (!buyOrderId || !quantity) {
    return Response.json({ error: 'buyOrderId and quantity are required' }, { status: 400 });
  }

  const [emailSetting, passwordSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
    prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ error: 'CardCenter credentials not configured' }, { status: 400 });
  }

  const token = await getCcToken(emailSetting.value, passwordSetting.value);

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
    groups: Array<{ reservation: { id: number; status: string; submissionDeadline?: string } }>;
  };

  const submissionId = submission.id;
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

  return Response.json({
    reservationId: reservation.id,
    submissionId,
    submissionDeadline: reservation.submissionDeadline,
  });
}
