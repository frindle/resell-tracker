import type { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '@/lib/db';
import { scheduleBooksReconcile } from '@/lib/books/service';
import { withCancelledTotal } from '@/lib/orderNotes';

// Cancelling an order, from the order page's Cancel button or a retailer's
// cancellation email. Its units stop counting against every group it was
// linked to (BigSky set-asides, BuyingGroup commitments, BFMR reservations),
// so those show as open again. Nothing is sent to the groups from here; what a
// cancel email does on BuyingGroup and BFMR is lib/cancelReducePlan.ts's job.

export type ReleasedLink = { group: 'BigSky' | 'BuyingGroup' | 'BFMR'; name: string; quantity: number; /** BuyingGroup: the commitment row the units came off, for the BG reduction. */ commitmentId?: number };

type Db = Prisma.TransactionClient;

export async function releaseOrderLinks(tx: Db, orderId: number): Promise<ReleasedLink[]> {
  const [bigsky, bg, bfmr] = await Promise.all([
    tx.orderBigSkyLink.findMany({ where: { orderId }, select: { quantity: true, commitment: { select: { itemName: true } } } }),
    tx.orderCommitmentLink.findMany({ where: { orderId }, select: { quantity: true, commitmentId: true, commitment: { select: { dealTitle: true } } } }),
    tx.orderBfmrLink.findMany({ where: { orderId }, select: { quantity: true, reservation: { select: { itemName: true, dealTitle: true } } } }),
  ]);
  await tx.orderBigSkyLink.deleteMany({ where: { orderId } });
  await tx.orderCommitmentLink.deleteMany({ where: { orderId } });
  await tx.orderBfmrLink.deleteMany({ where: { orderId } });
  return [
    ...bigsky.map(l => ({ group: 'BigSky' as const, name: l.commitment.itemName, quantity: l.quantity })),
    ...bg.map(l => ({ group: 'BuyingGroup' as const, name: l.commitment.dealTitle, quantity: l.quantity, commitmentId: l.commitmentId })),
    ...bfmr.map(l => ({ group: 'BFMR' as const, name: l.reservation.itemName ?? l.reservation.dealTitle ?? 'reservation', quantity: l.quantity })),
  ];
}

/**
 * `total` is the cancelled amount the email gave, used when the order has no
 * cost of its own. The real total goes into the order's notes before the money
 * fields are zeroed, so it stays visible while the order stays out of P&L.
 */
export async function cancelOrder(orderId: number, userId: number | null, opts: { total?: number } = {}) {
  scheduleBooksReconcile(userId);
  return prisma.$transaction(async tx => {
    const released = await releaseOrderLinks(tx, orderId);
    const before = await tx.order.findUnique({ where: { id: orderId }, select: { cost: true, notes: true } });
    const total = before && before.cost > 0 ? before.cost : (opts.total ?? 0);
    const order = await tx.order.update({
      where: { id: orderId },
      data: {
        notes: withCancelledTotal(before?.notes, total),
        cost: 0,
        shippingCost: 0,
        insuranceCost: 0,
        salePrice: 0,
        cashbackAmount: 0,
        memberReward: null,
        cancelled: true,
        locked: true,
      },
    });
    return { order, released };
  });
}

/** An order that was already cancelled but still holds group units. */
export async function releaseCancelledOrder(orderId: number): Promise<ReleasedLink[]> {
  return prisma.$transaction(tx => releaseOrderLinks(tx, orderId));
}
