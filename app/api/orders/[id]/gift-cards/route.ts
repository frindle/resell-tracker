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
    const card = await prisma.giftCard.create({ data: { orderId, merchant, value, cardNumber, pin: pin ?? null } });
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

    const body = await req.json() as { cardId: number; ccSubmittedAt?: string | null; ccGiftCardId?: string | null; ccReservationId?: number | null; ccSubmissionId?: string | null };
    const { cardId } = body;
    const data: Record<string, unknown> = {};
    if ('ccSubmittedAt' in body) data.ccSubmittedAt = body.ccSubmittedAt ?? null;
    if ('ccGiftCardId' in body) data.ccGiftCardId = body.ccGiftCardId || null;
    if ('ccReservationId' in body) data.ccReservationId = body.ccReservationId ?? null;
    if ('ccSubmissionId' in body) data.ccSubmissionId = body.ccSubmissionId ?? null;
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
