import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);

    const order = await prisma.order.findFirst({
      where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
      select: { id: true },
    });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const cards = await prisma.giftCard.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    return Response.json(cards);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Gift card codes and PINs are pasted from emails/receipts and routinely
// arrive with spaces (and sometimes newlines) inside them — "1234 5678 9012".
// CardCenter matches on the bare code, so strip ALL whitespace before it's
// stored, not just the ends. Applied in the route so every caller (form,
// PATCH edit, importers) gets it, rather than at one input handler.
function stripWs(s: string) {
  return s.replace(/\s+/g, '');
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);
    const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
    if (lockErr) return lockErr;

    const order = await prisma.order.findFirst({
      where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
      select: { id: true },
    });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const { merchant, value, cardNumber, pin } = await req.json() as { merchant: string; value: number; cardNumber: string; pin?: string };
    const card = await prisma.giftCard.create({
      data: { orderId, merchant: merchant.trim(), value, cardNumber: stripWs(cardNumber), pin: pin ? stripWs(pin) || null : null },
    });
    return Response.json(card);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);
    const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
    if (lockErr) return lockErr;

    const order = await prisma.order.findFirst({
      where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
      select: { id: true },
    });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json() as {
      cardId: number;
      merchant?: string;
      value?: number;
      cardNumber?: string;
      pin?: string | null;
      ccSubmittedAt?: string | null;
      ccGiftCardId?: string | null;
      ccListingId?: string | null;
      ccReservationId?: number | null;
      ccSubmissionId?: string | null;
      ccPurchasePrice?: number | null;
      ccPaymentStatus?: string | null;
      ccPaymentName?: string | null;
      ccPaymentDueAt?: string | null;
    };
    const { cardId } = body;
    const data: Record<string, unknown> = {};
    // User-correctable fields — used to fix data-entry typos (most often
    // a misspelled merchant that's blocking the CC match) without dropping
    // and re-adding the card.
    if (typeof body.merchant === 'string' && body.merchant.trim()) data.merchant = body.merchant.trim();
    if (typeof body.value === 'number' && body.value > 0) data.value = body.value;
    if (typeof body.cardNumber === 'string' && stripWs(body.cardNumber)) data.cardNumber = stripWs(body.cardNumber);
    if ('pin' in body) data.pin = body.pin ? stripWs(body.pin) || null : null;
    if ('ccSubmittedAt' in body) data.ccSubmittedAt = body.ccSubmittedAt ?? null;
    // The CC identity/payment fields must all be individually clearable: a
    // wrongly-assigned ID (see the sync-payments orphan back-fill) drags a
    // bogus ccPurchasePrice + payment status along with it, and clearing only
    // ccGiftCardId left the card still rendering (and still counting) as paid.
    if ('ccGiftCardId' in body) data.ccGiftCardId = body.ccGiftCardId || null;
    if ('ccListingId' in body) data.ccListingId = body.ccListingId || null;
    if ('ccReservationId' in body) data.ccReservationId = body.ccReservationId ?? null;
    if ('ccSubmissionId' in body) data.ccSubmissionId = body.ccSubmissionId ?? null;
    if ('ccPurchasePrice' in body) data.ccPurchasePrice = body.ccPurchasePrice ?? null;
    if ('ccPaymentStatus' in body) data.ccPaymentStatus = body.ccPaymentStatus || null;
    if ('ccPaymentName' in body) data.ccPaymentName = body.ccPaymentName || null;
    if ('ccPaymentDueAt' in body) data.ccPaymentDueAt = body.ccPaymentDueAt ? new Date(body.ccPaymentDueAt) : null;
    if (Object.keys(data).length === 0) return Response.json({ error: 'No editable fields provided' }, { status: 400 });
    const result = await prisma.giftCard.updateMany({
      where: { id: cardId, orderId },
      data,
    });
    if (!result.count) return Response.json({ error: 'Not found' }, { status: 404 });
    const updated = await prisma.giftCard.findUnique({ where: { id: cardId } });
    return Response.json(updated);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);
    const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
    if (lockErr) return lockErr;

    const order = await prisma.order.findFirst({
      where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
      select: { id: true },
    });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const { cardId } = await req.json() as { cardId: number };
    await prisma.giftCard.deleteMany({ where: { id: cardId, orderId } });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
