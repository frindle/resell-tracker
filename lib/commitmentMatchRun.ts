import { prisma } from '@/lib/db';
import { recalcSalePrice } from '@/lib/commitmentSalePrice';
import { recalcBigSkySalePrice } from '@/lib/bigskySalePriceRecalc';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { expectedLinkValue } from '@/lib/bfmrLinkValue';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';
import { matchOrdersWith, type MatchRunResult, type MatchStore } from '@/lib/commitmentMatchCore';

// Runs lib/commitmentMatch.ts for orders CREATED by the current import (the
// caller passes only those: an order that merely changed in a full sync, or a
// personal buy that was already there, is never linked here). It only ever ADDS
// a link, and only when exactly one open reservation or commitment fits the
// order's item, units and date. An order that already has any link is left
// alone. A BFMR reservation, BG commitment or BigSky commitment the person
// unlinked on purpose (autoLinkDismissedAt) is not a candidate. The order's item
// name is never replaced from a link; a blank buyer is still filled the way a
// manual link does. Nothing here writes an address. Logs counts only. The
// result names the orders it could not place so the caller can alert on them.
export type { MatchRunResult };

export async function matchOrdersToCommitments(
  userId: number | null,
  createdOrderIds: readonly number[],
  quantities: ReadonlyMap<number, number> = new Map(), // real units per order id; absent = unknown
  nowMs: number = Date.now(),
): Promise<MatchRunResult> {
  const store: MatchStore = {
    loadOrders: ids => prisma.order.findMany({
      where: {
        id: { in: [...ids] }, userId, cancelled: false, locked: false,
        bfmrLinks: { none: {} }, commitmentLinks: { none: {} }, bigSkyLinks: { none: {} },
      },
      select: { id: true, itemDescription: true, orderDate: true },
    }),
    loadCandidateRows: async () => {
      const [bfmr, bg, bigsky] = await Promise.all([
        prisma.bfmrReservation.findMany({
          where: { userId, autoLinkDismissedAt: null },
          select: { id: true, itemName: true, dealTitle: true, qty: true, status: true, _count: { select: { orderLinks: true } } },
        }),
        prisma.buyingGroupCommitment.findMany({
          where: { userId, autoLinkDismissedAt: null },
          select: { id: true, dealTitle: true, count: true, status: true, expiryDay: true, createdDt: true, orderLinks: { select: { quantity: true } } },
        }),
        prisma.bigSkyCommitment.findMany({
          where: { userId, autoLinkDismissedAt: null },
          select: { id: true, itemName: true, commitmentAmount: true, fulfilled: true, status: true, dealExpiration: true, dealCreated: true, creationDate: true, orderLinks: { select: { quantity: true } } },
        }),
      ]);
      const sum = (l: { quantity: number }[]) => l.reduce((n, x) => n + x.quantity, 0);
      return {
        bfmr: bfmr.map(r => ({ ...r, linkCount: r._count.orderLinks })),
        bg: bg.map(c => ({ ...c, assignedQty: sum(c.orderLinks) })),
        bigsky: bigsky.map(c => ({ ...c, plannedQty: sum(c.orderLinks) })),
      };
    },
    link: async (c, orderId, quantity) => {
      if (c.group === 'BG') {
        await prisma.orderCommitmentLink.create({ data: { orderId, commitmentId: c.id, quantity } });
        await recalcSalePrice(orderId);
      } else if (c.group === 'BigSky') {
        await prisma.orderBigSkyLink.create({ data: { orderId, commitmentId: c.id, quantity } });
        await recalcBigSkySalePrice(orderId);
      } else {
        const r = await prisma.bfmrReservation.findUnique({ where: { id: c.id }, select: { qty: true, totalPayout: true } });
        if (!r) throw new Error('reservation gone');
        await prisma.orderBfmrLink.create({
          data: { orderId, reservationId: c.id, quantity, value: expectedLinkValue(r.totalPayout, r.qty, quantity) },
        });
        await recalcBfmrSalePrice(orderId, { respectLock: true });
      }
      // keepItem: the order's own item name stays; only a blank buyer is filled.
      await syncOrderFromLinks(orderId, { keepItem: true });
    },
  };
  return matchOrdersWith(store, createdOrderIds, quantities, nowMs);
}
