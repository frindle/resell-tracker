import { NextRequest } from 'next/server';
import { getSetting, prisma } from '@/lib/db';
import { cancelReservation } from '@/lib/bfmrWeb';
import { getSessionUserId } from '@/lib/auth';
import { getBfmrRestCreds, cancelReservationsRest } from '@/lib/bfmrDeals';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const { trackerRow } = await req.json() as { trackerRow: Record<string, unknown> };
  if (!trackerRow) return new Response('trackerRow required', { status: 400 });

  const creds = await getBfmrRestCreds(uid);
  const reserveId = trackerRow.reserve_id != null ? String(trackerRow.reserve_id) : '';
  try {
    if (creds) {
      if (!reserveId) return new Response('This row has no reservation id to cancel', { status: 400 });
      const invalid = await cancelReservationsRest(creds, [reserveId]);
      if (invalid.length) return new Response(`BFMR wouldn't cancel reservation ${reserveId} (already purchased or closed?)`, { status: 409 });
    } else {
      const emailRow = await getSetting(uid, 'bfmr_email');
      const passwordRow = await getSetting(uid, 'bfmr_password');
      if (!emailRow?.value || !passwordRow?.value) {
        return new Response('BFMR not configured: add your API key and secret in Settings', { status: 400 });
      }
      await cancelReservation(emailRow.value, passwordRow.value, trackerRow, uid);
    }
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
