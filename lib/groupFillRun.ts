import { prisma } from '@/lib/db';
import { parseUserEditedFields } from '@/lib/orderFieldSync';
import { bfmrCandidates, bgCandidates, bigskyCandidates } from '@/lib/commitmentMatch';
import { decideGroup, countDecisions, type Deal, type DealGroup, type FillCounts, type GroupDecision } from '@/lib/groupFill';

// Fills the empty group of orders (lib/groupFill.ts). Writes the group and
// nothing else, only where it is still empty, so a group set meanwhile (by a
// person or another sync) is never replaced. Logs counts only.

export type GroupFillResult = {
  counts: FillCounts;
  /** Per store: orders scanned, groups set (or that would be), orders still without one. */
  byPlatform: Record<string, { scanned: number; filled: number; left: number }>;
  /** Orders still without a group, for the caller to queue a page read. */
  left: { id: number; platform: string; orderNumber: string | null; cancelled: boolean; locked: boolean }[];
  written: number;
};

export async function fillGroups(
  userId: number | null,
  scope: { orderIds?: readonly number[]; days?: number },
  apply: boolean,
  nowMs: number = Date.now(),
): Promise<GroupFillResult> {
  const userFilter = userId ? { userId } : { userId: null };
  const where = {
    ...userFilter, buyerId: null, ignoredByRule: false,
    ...(scope.orderIds ? { id: { in: [...scope.orderIds] } } : { orderDate: { gte: new Date(nowMs - (scope.days ?? 30) * 86_400_000) } }),
  };
  const orders = await prisma.order.findMany({
    where,
    select: { id: true, platform: true, orderNumber: true, orderDate: true, itemDescription: true, shippingAddress: true, userEditedFields: true, cancelled: true, locked: true },
  });
  const empty: GroupFillResult = { counts: countDecisions([]), byPlatform: {}, left: [], written: 0 };
  if (!orders.length) return empty;

  const [rules, buyers, bfmr, bg, bigsky] = await Promise.all([
    prisma.shippingRule.findMany({ where: { ...userFilter, buyerId: { not: null } }, select: { pattern: true, buyerId: true } }),
    prisma.buyer.findMany({ select: { id: true, name: true } }),
    prisma.bfmrReservation.findMany({ where: { userId }, select: { id: true, itemName: true, dealTitle: true, qty: true, status: true } }),
    prisma.buyingGroupCommitment.findMany({ where: { userId }, select: { id: true, dealTitle: true, count: true, status: true, expiryDay: true, createdDt: true } }),
    prisma.bigSkyCommitment.findMany({ where: { userId }, select: { id: true, itemName: true, commitmentAmount: true, fulfilled: true, status: true, dealExpiration: true, dealCreated: true, creationDate: true } }),
  ]);
  const buyerIdFor = (group: DealGroup): number | null =>
    (buyers.find(b => b.name === group) ?? buyers.find(b => b.name.toLowerCase().includes(group.toLowerCase())))?.id ?? null;

  // A live order only sees open deals; a cancelled one also sees voided,
  // expired and cancelled ones, since what it was bought for may be over.
  const allDeals: Deal[] = [
    ...bfmr.map(r => ({ group: 'BFMR' as const, name: r.itemName || r.dealTitle || '' })),
    ...bg.map(c => ({ group: 'BuyingGroup' as const, name: c.dealTitle, createdAt: c.createdDt ? c.createdDt.getTime() : null })),
    ...bigsky.map(c => ({ group: 'BigSkyBuyers' as const, name: c.itemName, createdAt: (c.dealCreated ?? c.creationDate)?.getTime() ?? null })),
  ];
  const GROUP_OF = { BFMR: 'BFMR', BG: 'BuyingGroup', BigSky: 'BigSkyBuyers' } as const;
  const openDeals: Deal[] = [
    ...bfmrCandidates(bfmr.map(r => ({ ...r, linkCount: 0 }))),
    ...bgCandidates(bg.map(c => ({ ...c, assignedQty: 0 })), nowMs),
    ...bigskyCandidates(bigsky.map(c => ({ ...c, plannedQty: 0 })), nowMs),
  ].map(c => ({ group: GROUP_OF[c.group], name: c.name, ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}) }));

  const decisions: GroupDecision[] = [];
  const result: GroupFillResult = { counts: empty.counts, byPlatform: {}, left: [], written: 0 };
  for (const o of orders) {
    const d = decideGroup(
      { buyerId: null, userEditedFields: parseUserEditedFields(o.userEditedFields), shippingAddress: o.shippingAddress, itemDescription: o.itemDescription, orderDateMs: o.orderDate.getTime() },
      rules, o.cancelled ? allDeals : openDeals, buyerIdFor,
    );
    decisions.push(d);
    const p = (result.byPlatform[o.platform] ??= { scanned: 0, filled: 0, left: 0 });
    p.scanned++;
    if (d.kind === 'set') {
      p.filled++;
      if (apply) {
        const r = await prisma.order.updateMany({ where: { id: o.id, buyerId: null }, data: { buyerId: d.buyerId } });
        result.written += r.count;
      }
    } else {
      p.left++;
      // A group the person cleared on purpose is left alone, not chased.
      if (d.kind !== 'keep') result.left.push({ id: o.id, platform: o.platform, orderNumber: o.orderNumber, cancelled: o.cancelled, locked: o.locked });
    }
  }
  result.counts = countDecisions(decisions);
  console.log(`[group-fill] ${apply ? 'applied' : 'dry'} scanned=${result.counts.scanned} rule=${result.counts.byRule} item=${result.counts.byItem} ambiguous=${result.counts.ambiguous} none=${result.counts.none} written=${result.written}`);
  return result;
}
