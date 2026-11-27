import { prisma } from '@/lib/db';
import { sameTracking, storedFulfillments } from '@/lib/bigskyCommitments';
import {
  deliveryVsReceived, groupFor, groupReceiptFor, trackingKey, type DeliveryVsReceived, type DeliveryRow,
} from '@/lib/deliveryVsReceived';

// Database side of lib/deliveryVsReceived.ts: a fixed handful of queries however many orders are passed in.

export type DeliveryOrder = {
  id: number;
  trackingNumbers: string | null;
  bfmrReceived?: boolean | null;
  bfmrStatus?: string | null;
  buyer?: { name: string } | null;
};

/** Carrier delivery and group receipt per order id. Orders with no tracking number and no group are left out. */
export async function loadDeliveryVsReceived(uid: number | null, orders: readonly DeliveryOrder[]): Promise<Map<number, DeliveryVsReceived>> {
  const out = new Map<number, DeliveryVsReceived>();
  if (uid == null || !orders.length) return out;
  const ids = orders.map(o => o.id);
  const numbersOf = (o: DeliveryOrder) => String(o.trackingNumbers ?? '').split(',').map(trackingKey).filter(Boolean);
  const allNumbers = [...new Set(orders.flatMap(numbersOf))];

  const [rows, bgLinks, bfmrLinks, bigSkyLinks] = await Promise.all([
    allNumbers.length
      ? prisma.carrierDelivery.findMany({
          where: { userId: uid, trackingNumber: { in: allNumbers } },
          select: { trackingNumber: true, carrier: true, status: true, deliveredAt: true, source: true },
        })
      : Promise.resolve([] as DeliveryRow[]),
    prisma.orderCommitmentLink.findMany({
      where: { orderId: { in: ids } },
      select: { orderId: true, commitment: { select: { count: true, fulfilled: true, fulfilledAt: true } } },
    }),
    prisma.orderBfmrLink.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, reservation: { select: { status: true } } } }),
    prisma.orderBigSkyLink.findMany({ where: { orderId: { in: ids } }, select: { orderId: true } }),
  ]);

  const bigSkyOrderIds = new Set(bigSkyLinks.map(l => l.orderId));
  const wantsBigSky = orders.some(o => bigSkyOrderIds.has(o.id) || /big\s*sky/i.test(o.buyer?.name ?? ''));
  const bigSkyRows = wantsBigSky
    ? await prisma.bigSkyCommitment.findMany({ where: { userId: uid }, select: { fulfillments: true } })
    : [];
  const scans = bigSkyRows.flatMap(r => storedFulfillments(r.fulfillments));

  const by = <T extends { orderId: number }>(list: readonly T[]) => {
    const m = new Map<number, T[]>();
    for (const l of list) (m.get(l.orderId) ?? m.set(l.orderId, []).get(l.orderId)!).push(l);
    return m;
  };
  const bgBy = by(bgLinks), bfmrBy = by(bfmrLinks);
  const now = new Date();

  for (const o of orders) {
    const bg = bgBy.get(o.id) ?? [], bf = bfmrBy.get(o.id) ?? [];
    const group = groupFor({ buyerName: o.buyer?.name, hasBgLink: bg.length > 0, hasBfmrLink: bf.length > 0, hasBigSkyLink: bigSkyOrderIds.has(o.id) });
    const numbers = numbersOf(o);
    if (!numbers.length && !group) continue;
    const mine = scans.filter(f => (f.trackingNumbers ?? []).some(t => numbers.some(n => sameTracking(t, n))));
    const received = groupReceiptFor(group, {
      bfmrReceived: o.bfmrReceived,
      bfmrStatus: o.bfmrStatus,
      reservationStatuses: bf.map(l => l.reservation.status),
      commitments: bg.map(l => l.commitment),
      bigSkyScanDates: mine.map(f => { const d = new Date(f.date); return Number.isFinite(d.getTime()) ? d : null; }),
    });
    out.set(o.id, deliveryVsReceived({ trackingNumbers: numbers, rows, received, now }));
  }
  return out;
}
