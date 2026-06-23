import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get('orderId');

  const rows = await prisma.bfmrReservation.findMany({
    where: { userId: uid },
    orderBy: { lastSyncedAt: 'desc' },
    include: {
      orderLinks: {
        include: {
          order: { select: { id: true, orderNumber: true, platform: true, trackingNumbers: true } },
        },
      },
    },
  });

  const reservations = rows.map(r => ({
    id: r.id,
    reserveId: r.reserveId,
    purchaseId: r.purchaseId,
    shipmentId: r.shipmentId,
    bfmrOrderId: r.bfmrOrderId,
    trackingNumber: r.trackingNumber,
    dealTitle: r.dealTitle,
    itemName: r.itemName,
    status: r.status,
    qty: r.qty,
    retailPrice: r.retailPrice,
    totalPayout: r.totalPayout,
    datePaid: r.datePaid?.toISOString() ?? null,
    lastSyncedAt: r.lastSyncedAt.toISOString(),
    orderLinks: r.orderLinks.map(l => ({
      id: l.id,
      orderId: l.orderId,
      trackingNumber: l.trackingNumber,
      quantity: l.quantity,
      value: l.value,
      order: l.order,
    })),
  }));

  if (orderId) {
    const oid = parseInt(orderId);
    const order = await prisma.order.findUnique({
      where: { id: oid },
      select: { orderNumber: true, trackingNumbers: true },
    });
    if (!order) return Response.json({ reservations: [] });

    const norm = (order.orderNumber ?? '').replace(/\D/g, '');
    const matching = reservations.filter(r => {
      const rNorm = (r.bfmrOrderId ?? '').replace(/\D/g, '');
      if (norm && rNorm && rNorm === norm) return true;
      if (order.trackingNumbers && r.trackingNumber) {
        const orderTrackings = order.trackingNumbers.split(',').map(t => t.trim());
        if (orderTrackings.includes(r.trackingNumber)) return true;
      }
      const isLinked = r.orderLinks.some(l => l.orderId === oid);
      if (isLinked) return true;
      return false;
    });
    return Response.json({ reservations: matching });
  }

  return Response.json({ reservations });
}
