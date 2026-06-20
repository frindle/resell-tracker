import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, ccJson } from '@/lib/cardcenter';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// POST /api/cardcenter/fulfill-reservation
// Body: { reservationId: number, cardIds: number[] }
// Submits card codes against an existing approved reservation.
export async function POST(req: NextRequest) {
  try {
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
      select: { id: true, cardNumber: true, orderId: true, ccSubmittedAt: true },
    });
    if (cards.length !== cardIds.length) {
      return Response.json({ error: 'Invalid card IDs' }, { status: 403 });
    }

    const orderId = cards[0].orderId;
    const unsubmitted = cards.filter(c => !c.ccSubmittedAt);
    if (unsubmitted.length === 0) {
      return Response.json({ submitted: 0, skipped: cards.length, overdueAt: null });
    }
    const lockError = await requireOrderUnlocked(orderId, userId);
    if (lockError) return lockError;

    const token = await getCcToken(emailSetting.value, passwordSetting.value);

    await prisma.giftCard.updateMany({
      where: { id: { in: cardIds } },
      data: { ccReservationId: reservationId },
    });

    const codes = unsubmitted.map(c => c.cardNumber).join('\n');
    const parseRes = await fetch(`${BASE_URL}/Api/Reservations/${reservationId}/ParsedCards`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: codes }),
    });
    if (!parseRes.ok) {
      const text = await parseRes.text().catch(() => String(parseRes.status));
      return Response.json({ error: `ParsedCards failed: ${text}` }, { status: 502 });
    }
    type ParsedCard = { brand: unknown; value: unknown; code: string };
    type ParsedGroup = { brand: unknown; value: unknown; quantity: number; offers: Array<{ reservation: Record<string, unknown> }> };
    const parsed = await ccJson<{
      cards: Array<ParsedCard>;
      submission: { groups: Array<ParsedGroup>; sellerAgreement?: { agreement?: { id: string; date: string } } };
    }>(parseRes, `Reservations/${reservationId}/ParsedCards`);

    const firstOffer = parsed.submission.groups[0]?.offers?.[0];
    if (!firstOffer?.reservation) {
      return Response.json({ error: 'ParsedCards returned no reservation in offers' }, { status: 502 });
    }
    const seller = firstOffer.reservation.seller as { id: number; email: string };
    const acceptAgreement = parsed.submission.sellerAgreement?.agreement;
    let cardIdx = 0;
    const groups = parsed.submission.groups.map(g => {
      const cards = parsed.cards.slice(cardIdx, cardIdx + g.quantity);
      cardIdx += g.quantity;
      return { brand: g.brand, value: g.value, quantity: g.quantity, reservation: g.offers[0].reservation, cards };
    });
    const submitRes = await fetch(`${BASE_URL}/Api/Submissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller, groups, ...(acceptAgreement ? { acceptAgreement } : {}) }),
    });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => String(submitRes.status));
      return Response.json({ error: `Submission failed: ${text}` }, { status: 502 });
    }

    type SubmissionShape = {
      id: string;
      groups: Array<{ submittedCards?: Array<{ giftCard: { id: number; code: string }; paymentReceivedOn: string }> }>;
    };
    const submission = await ccJson<SubmissionShape>(submitRes, 'Submissions');

    // POST response doesn't include submittedCards — fetch the detail to get them
    const detailRes = await fetch(`${BASE_URL}/Api/Submissions/${submission.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = detailRes.ok
      ? await ccJson<SubmissionShape>(detailRes, `Submissions/${submission.id}`)
      : submission;

    await prisma.giftCard.updateMany({
      where: { id: { in: unsubmitted.map(c => c.id) } },
      data: { ccSubmittedAt: new Date() },
    });

    // Populate ccGiftCardId by matching card code suffix from submittedCards
    const submittedCards = detail.groups.flatMap(g => g.submittedCards ?? []);
    for (const card of unsubmitted) {
      const match = submittedCards.find(sc => card.cardNumber.endsWith(sc.giftCard.code.replace(/^…/, '')));
      if (match) {
        await prisma.giftCard.update({
          where: { id: card.id },
          data: { ccGiftCardId: String(match.giftCard.id) },
        });
      }
    }

    // Use paymentReceivedOn from submittedCards instead of querying Payments
    let overdueAt: Date | null = null;
    const receivedOn = submittedCards[0]?.paymentReceivedOn;
    if (receivedOn) overdueAt = new Date(receivedOn);

    if (overdueAt) {
      await prisma.order.update({ where: { id: orderId }, data: { overdueAt } });
    }

    return Response.json({ submitted: unsubmitted.length, skipped: cards.length - unsubmitted.length, overdueAt: overdueAt?.toISOString() ?? null });
  } catch (e) {
    console.error('[cardcenter/fulfill-reservation]', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
