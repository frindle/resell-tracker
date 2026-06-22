import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { submitTracking } from '@/lib/bfmrWeb';

export async function POST() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) {
    return new Response('BFMR credentials not configured', { status: 400 });
  }

  const orders = await prisma.order.findMany({
    where: {
      userId: uid,
      trackingNumbers: { not: null },
      orderNumber: { not: null },
    },
    select: { orderNumber: true, trackingNumbers: true },
  });

  // Build trackingMap: { [orderNumber]: trackingNumber[] }
  // Pass ALL tracking numbers per order so split shipments submit in full
  // when BFMR exposes N rows for the same order_id. submitTracking() pops
  // one tracking per matched row and skips rows that already have one set.
  const trackingMap: Record<string, string[]> = {};
  for (const o of orders) {
    if (!o.orderNumber || !o.trackingNumbers) continue;
    const trackings = o.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
    if (trackings.length > 0) trackingMap[o.orderNumber] = trackings;
  }

  if (Object.keys(trackingMap).length === 0) {
    return Response.json({ pushed: 0 });
  }

  try {
    await submitTracking(emailRow.value, passwordRow.value, trackingMap, uid);
    return Response.json({ pushed: Object.keys(trackingMap).length });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
