import { prisma } from '@/lib/db';
import { recalcSalePrice } from '@/lib/commitmentSalePrice';
import { recalcBigSkySalePrice } from '@/lib/bigskySalePriceRecalc';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { expectedLinkValue } from '@/lib/bfmrLinkValue';
import { syncOrderFromLinks } from '@/lib/linkedItemsSync';
import {
  matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates,
  type Candidate, type MatchOutcome,
} from '@/lib/commitmentMatch';

// Runs lib/commitmentMatch.ts for orders that were just created or filled.
// It only ever ADDS a link, and only when exactly one open reservation or
// commitment fits the order's item and units. An order that already has any
// link (BFMR, BG or BigSky) is left alone: a person put that link there, or
// an earlier run did. A BFMR reservation the person unlinked on purpose
// (autoLinkDismissedAt) is not a candidate. Nothing here writes an address;
// syncOrderFromLinks fills a blank buyer from the link the way a manual link
// does. Logs counts only. The result names the orders it could not place so
// the caller can alert on them.
export type MatchRunResult = {
  linked: number;
  /** Orders left unlinked, with why. Never includes orders that were skipped as already linked. */
  unplaced: { orderId: number; reason: Exclude<MatchOutcome['kind'], 'link'> }[];
};

export async function matchOrdersToCommitments(
  userId: number | null,
  orderIds: readonly number[],
  quantities: ReadonlyMap<number, number> = new Map(),
  nowMs: number = Date.now(),
): Promise<MatchRunResult> {
  const result: MatchRunResult = { linked: 0, unplaced: [] };
  if (!orderIds.length) return result;

  const orders = await prisma.order.findMany({
    where: {
      id: { in: [...orderIds] }, userId, cancelled: false, locked: false,
      bfmrLinks: { none: {} }, commitmentLinks: { none: {} }, bigSkyLinks: { none: {} },
    },
    select: { id: true, itemDescription: true },
  });
  if (!orders.length) return result;

  const [bfmr, bg, bigsky] = await Promise.all([
    prisma.bfmrReservation.findMany({
      where: { userId, autoLinkDismissedAt: null },
      select: { id: true, itemName: true, dealTitle: true, qty: true, status: true, _count: { select: { orderLinks: true } } },
    }),
    prisma.buyingGroupCommitment.findMany({
      where: { userId },
      select: { id: true, dealTitle: true, count: true, fulfilled: true, status: true, expiryDay: true, orderLinks: { select: { quantity: true } } },
    }),
    prisma.bigSkyCommitment.findMany({
      where: { userId },
      select: { id: true, itemName: true, commitmentsRemaining: true, dealExpiration: true },
    }),
  ]);
  // Units already claimed in this run come off what the next order sees.
  const taken = new Map<string, number>();
  const key = (c: Candidate) => `${c.group}:${c.id}`;
  const candidates = (): Candidate[] => [
    ...bfmrCandidates(bfmr.map(r => ({ ...r, linkCount: r._count.orderLinks }))),
    ...bgCandidates(bg.map(c => ({ ...c, linkedQty: c.orderLinks.reduce((n, l) => n + l.quantity, 0) })), nowMs),
    ...bigskyCandidates(bigsky, nowMs),
  ].map(c => ({ ...c, remaining: c.remaining - (taken.get(key(c)) ?? 0) })).filter(c => c.remaining > 0);

  for (const o of orders) {
    const quantity = quantities.get(o.id) ?? 1;
    const out = matchOrder({ itemDescription: o.itemDescription, quantity }, candidates());
    if (out.kind !== 'link') {
      result.unplaced.push({ orderId: o.id, reason: out.kind });
      continue;
    }
    const c = out.candidate;
    try {
      if (c.group === 'BG') {
        await prisma.orderCommitmentLink.create({ data: { orderId: o.id, commitmentId: c.id, quantity } });
        await recalcSalePrice(o.id);
      } else if (c.group === 'BigSky') {
        await prisma.orderBigSkyLink.create({ data: { orderId: o.id, commitmentId: c.id, quantity } });
        await recalcBigSkySalePrice(o.id);
      } else {
        const r = await prisma.bfmrReservation.findUnique({ where: { id: c.id }, select: { qty: true, totalPayout: true } });
        if (!r) continue;
        await prisma.orderBfmrLink.create({
          data: { orderId: o.id, reservationId: c.id, quantity, value: expectedLinkValue(r.totalPayout, r.qty, quantity) },
        });
        await recalcBfmrSalePrice(o.id, { respectLock: true });
      }
      await syncOrderFromLinks(o.id);
      taken.set(key(c), (taken.get(key(c)) ?? 0) + quantity);
      result.linked++;
    } catch (e) {
      console.warn(`[commitment-match] link failed group=${c.group}:`, String(e).slice(0, 160));
    }
  }
  console.log(`[commitment-match] orders=${orders.length} linked=${result.linked} unplaced=${result.unplaced.length}`);
  return result;
}
