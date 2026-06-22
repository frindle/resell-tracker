import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Create a link between an order and a BG commitment with a quantity.
// Used from the order detail page's "BG Commitment" section.
//
// Body: { orderId: number; commitmentId: number; quantity: number }
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const body = await req.json() as { orderId?: number; commitmentId?: number; quantity?: number };
  if (typeof body.orderId !== 'number' || typeof body.commitmentId !== 'number') {
    return Response.json({ error: 'orderId and commitmentId required' }, { status: 400 });
  }
  const quantity = Math.max(1, Math.floor(body.quantity ?? 1));

  // Validate that both belong to this user
  const [order, commitment] = await Promise.all([
    prisma.order.findFirst({ where: { id: body.orderId, userId: uid }, select: { id: true } }),
    prisma.buyingGroupCommitment.findFirst({ where: { id: body.commitmentId, userId: uid }, select: { id: true } }),
  ]);
  if (!order)      return Response.json({ error: 'order not found' }, { status: 404 });
  if (!commitment) return Response.json({ error: 'commitment not found' }, { status: 404 });

  try {
    const link = await prisma.orderCommitmentLink.upsert({
      where: { orderId_commitmentId: { orderId: body.orderId, commitmentId: body.commitmentId } },
      create: { orderId: body.orderId, commitmentId: body.commitmentId, quantity },
      update: { quantity },
    });
    return Response.json(link);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
