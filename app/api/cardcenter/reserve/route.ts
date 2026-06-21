import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, ccJson } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

const BASE_URL = 'https://cardcenter.cc';

// POST /api/cardcenter/reserve
// Body: { buyOrderId: number, quantity: number, cardIds: number[] }
// Creates a reservation then immediately submits the card codes against it.
export async function POST(req: NextRequest) {
  try {
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

    const reserveCap = await ccJson<{
      id: string;
      groups: Array<{ reservation: { id: number; status: string; submissionDeadline?: string; submissionToken?: string } }>;
    }>(reserveRes, 'ReserveCap');

    const submissionId = reserveCap.id;

    // Poll until reservation is Approved (up to 30s)
    let reservation = reserveCap.groups?.[0]?.reservation;
    const deadline = Date.now() + 30000;
    while (reservation?.status === 'Processing' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await fetch(`${BASE_URL}/Api/Submissions/${submissionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (pollRes.ok) {
        const data = await ccJson<typeof reserveCap>(pollRes, `Submissions/${submissionId}`);
        reservation = data.groups?.[0]?.reservation;
      }
    }

    if (reservation?.status !== 'Approved') {
      return Response.json({ error: `Reservation did not approve in time (status: ${reservation?.status ?? 'unknown'})` }, { status: 504 });
    }

    // Submit card codes immediately against the approved reservation
    // Only submit as many cards as the reservation allows
    const cardsToSubmit = cards.slice(0, quantity);

    // Only link the reservation to cards we're actually submitting
    await prisma.giftCard.updateMany({
      where: { id: { in: cardsToSubmit.map(c => c.id) } },
      data: { ccReservationId: reservation.id, ccSubmissionId: submissionId },
    });
    const codes = cardsToSubmit.map(c => c.cardNumber).join('\n');

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

    const parsed = await ccJson<{ submission: { groups: unknown[] } }>(parseRes, `Reservations/${reservation.id}/ParsedCards`);

    // Fetch full reservation for seller info
    const reservationDetailRes = await fetch(`${BASE_URL}/Api/Reservations/${reservation.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reservationDetail = reservationDetailRes.ok
      ? await ccJson<{ id: number; seller: { id: number; email: string }; brand: { id: number; name: string; slug: string; type: string; image: { id: string } }; quantity: number }>(reservationDetailRes, `Reservations/${reservation.id}`)
      : null;

    if (!reservationDetail) {
      return Response.json({
        reservationId: reservation.id,
        submissionDeadline: reservation.submissionDeadline,
        submitError: 'Could not fetch reservation detail for seller info',
      });
    }

    type ParsedCard = { brand: unknown; value: unknown; code: string };
    type ParsedGroup = { brand: unknown; value: unknown; quantity: number; offers: Array<{ reservation: Record<string, unknown> }> };
    const parsedTyped = parsed as unknown as {
      cards: Array<ParsedCard>;
      submission: { groups: Array<ParsedGroup>; sellerAgreement?: { agreement?: { id: string; date: string } } };
    };
    const firstOffer = parsedTyped.submission.groups[0]?.offers?.[0];
    if (!firstOffer?.reservation) {
      return Response.json({ reservationId: reservation.id, submissionDeadline: reservation.submissionDeadline, submitError: 'ParsedCards returned no reservation in offers' });
    }
    const seller = firstOffer.reservation.seller as { id: number; email: string };
    const acceptAgreement = parsedTyped.submission.sellerAgreement?.agreement;
    let cardIdx = 0;
    const groups = parsedTyped.submission.groups.map(g => {
      const cards = parsedTyped.cards.slice(cardIdx, cardIdx + g.quantity);
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
      return Response.json({
        reservationId: reservation.id,
        submissionDeadline: reservation.submissionDeadline,
        submitError: `Submission failed: ${text}`,
      });
    }

    type SubmissionShape = {
      id: string;
      groups: Array<{ submittedCards?: Array<{ giftCard: { id: number; code: string }; paymentReceivedOn: string }> }>;
    };
    const submitResult = await ccJson<SubmissionShape>(submitRes, 'Submissions');

    // POST response doesn't include submittedCards — fetch the detail to get them
    const detailRes = await fetch(`${BASE_URL}/Api/Submissions/${submitResult.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = detailRes.ok
      ? await ccJson<SubmissionShape>(detailRes, `Submissions/${submitResult.id}`)
      : submitResult;

    // Mark only submitted cards as submitted
    await prisma.giftCard.updateMany({
      where: { id: { in: cardsToSubmit.map(c => c.id) } },
      data: { ccSubmittedAt: new Date() },
    });

    // Populate ccGiftCardId by matching card code suffix from submittedCards
    const submittedCards = detail.groups.flatMap(g => g.submittedCards ?? []);
    for (const card of cardsToSubmit) {
      const match = submittedCards.find(sc => card.cardNumber.endsWith(sc.giftCard.code.replace(/^…/, '')));
      if (match) {
        await prisma.giftCard.update({
          where: { id: card.id },
          data: { ccGiftCardId: String(match.giftCard.id) },
        });
      }
    }

    // Use paymentReceivedOn from submittedCards detail
    let overdueAt: Date | null = null;
    const receivedOn = submittedCards[0]?.paymentReceivedOn;
    if (receivedOn) overdueAt = new Date(receivedOn);

    const orderId = cards[0].orderId;
    if (overdueAt) {
      await prisma.order.update({ where: { id: orderId }, data: { overdueAt } });
    }

    return Response.json({
      reservationId: reservation.id,
      submissionDeadline: reservation.submissionDeadline,
      submitted: cardsToSubmit.length,
      overdueAt: overdueAt?.toISOString() ?? null,
    });
  } catch (e) {
    console.error('[cardcenter/reserve]', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
