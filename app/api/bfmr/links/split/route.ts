import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Atomically peel one item off an existing OrderBfmrLink into a fresh
// sibling link with no tracking. Mirrors BFMR's own split-shipment
// behavior: a qty-3 link gets split into a qty-2 link + a new qty-1
// link with no tracking, and the user assigns tracking to each as
// shipments leave.
//
// Body: { linkId: number, splitQty?: number }  (splitQty defaults to 1)
// Returns: { source: <updated link>, sibling: <new link> }
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const body = await req.json() as { linkId?: number; splitQty?: number };
  const linkId = body.linkId;
  const splitQty = Math.max(1, Math.floor(body.splitQty ?? 1));
  if (!linkId || !Number.isInteger(linkId)) {
    return Response.json({ error: 'linkId required' }, { status: 400 });
  }

  const link = await prisma.orderBfmrLink.findUnique({
    where: { id: linkId },
    include: { reservation: { select: { userId: true } } },
  });
  if (!link || link.reservation.userId !== uid) {
    return Response.json({ error: 'link not found' }, { status: 404 });
  }
  if (link.quantity <= splitQty) {
    return Response.json({ error: `cannot split — source qty ${link.quantity} ≤ split qty ${splitQty}` }, { status: 400 });
  }

  // link.value (when set) is an ABSOLUTE total for the source link's whole
  // quantity, not a per-unit rate — so a split must divide it proportionally
  // between source and sibling by quantity ratio, not copy it or drop it.
  const remainingQty = link.quantity - splitQty;
  let sourceValue = link.value;
  let siblingValue = null as number | null;
  if (link.value != null) {
    // Round the sibling's share and derive the source's as the remainder
    // (rather than rounding both independently) so the two always sum to
    // exactly the original value — independent rounding can drift a cent
    // off on some quantity/value combinations.
    const perUnit = link.value / link.quantity;
    siblingValue = Math.round(perUnit * splitQty * 100) / 100;
    sourceValue = Math.round((link.value - siblingValue) * 100) / 100;
  }

  const [source, sibling] = await prisma.$transaction([
    prisma.orderBfmrLink.update({
      where: { id: linkId },
      data: { quantity: remainingQty, value: sourceValue },
    }),
    prisma.orderBfmrLink.create({
      data: {
        orderId: link.orderId,
        reservationId: link.reservationId,
        trackingNumber: null,
        quantity: splitQty,
        value: siblingValue,
      },
    }),
  ]);

  await recalcBfmrSalePrice(link.orderId);
  return Response.json({ source, sibling });
}
