import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);
    const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
    if (lockErr) return lockErr;

    const order = await prisma.$transaction(async tx => {
      await tx.orderCommitmentLink.deleteMany({ where: { orderId } });
      await tx.orderBfmrLink.deleteMany({ where: { orderId } });
      return tx.order.update({
        where: { id: orderId },
        data: {
          cost: 0,
          shippingCost: 0,
          insuranceCost: 0,
          salePrice: 0,
          cashbackAmount: 0,
          cancelled: true,
          locked: true,
        },
      });
    });

    return Response.json(order);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
