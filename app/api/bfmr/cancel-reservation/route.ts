import { NextRequest } from 'next/server';
import { getSetting } from '@/lib/db';
import { cancelReservation } from '@/lib/bfmrWeb';
import { getSessionUserId } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) {
    return new Response('BFMR credentials not configured', { status: 400 });
  }

  const { trackerRow } = await req.json() as { trackerRow: Record<string, unknown> };
  if (!trackerRow) return new Response('trackerRow required', { status: 400 });

  try {
    await cancelReservation(emailRow.value, passwordRow.value, trackerRow, uid);
  } catch (e) {
    return new Response(`BFMR cancel failed: ${String(e)}`, { status: 502 });
  }

  // Update local order status if we can find it by order_id
  const orderId = trackerRow.order_id as string | undefined;
  if (orderId) {
    await prisma.order.updateMany({
      where: { orderNumber: orderId, ...(uid ? { userId: uid } : { userId: null }) },
      data: { bfmrStatus: 'cancelled' },
    });
  }

  return new Response(null, { status: 204 });
}
