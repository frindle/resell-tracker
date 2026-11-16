import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { cancelOrder } from '@/lib/orderCancel';
import { NextRequest } from 'next/server';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const orderId = parseInt(id);
    const lockErr = await requireOrderUnlocked(orderId, userId ?? null);
    if (lockErr) return lockErr;

    const { order } = await cancelOrder(orderId, userId ?? null);
    return Response.json(order);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
