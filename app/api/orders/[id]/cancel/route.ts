import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

// Cancelling an order zeroes out every money field, drops any BG/BFMR
// commitment links (freeing those slots back up elsewhere), and locks
// the order so nothing can un-cancel it by accident.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const sessionUid = await getSessionUserId();
  const headerUid = req.headers.get('X-Extension-User-Id');
  const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);
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

  return Response.json({ order });
}
