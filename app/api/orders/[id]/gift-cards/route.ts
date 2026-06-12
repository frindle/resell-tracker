import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const cards = await prisma.giftCard.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  return Response.json(cards);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const { merchant, value, cardNumber, pin } = await req.json() as { merchant: string; value: number; cardNumber: string; pin?: string };
  const card = await prisma.giftCard.create({ data: { orderId, merchant, value, cardNumber, pin: pin ?? null } });
  return Response.json(card);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const { cardId, ccSubmittedAt } = await req.json() as { cardId: number; ccSubmittedAt: string | null };
  const result = await prisma.giftCard.updateMany({
    where: { id: cardId, orderId },
    data: { ccSubmittedAt: ccSubmittedAt ?? null },
  });
  if (!result.count) return new Response('Not found', { status: 404 });
  const updated = await prisma.giftCard.findUnique({ where: { id: cardId } });
  return Response.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const { cardId } = await req.json() as { cardId: number };
  await prisma.giftCard.deleteMany({ where: { id: cardId, orderId } });
  return Response.json({ ok: true });
}
