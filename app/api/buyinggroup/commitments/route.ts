import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { isExpiryDayPast } from '@/lib/bgCommitmentLinkable';
import { bgPayoutTiers, reachableTier, underpaidTier } from '@/lib/bgPayoutTiers';
import { tierMismatch, carrierScanLine, lastDelivery } from '@/lib/bgTierMismatch';
import { carrierKey } from '@/lib/carrierQueue';

export const dynamic = 'force-dynamic';

// List the user's synced commitments. Includes linked orders + assigned
// quantities so the page can show "assigned / committed" at a glance.
export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const rows = await prisma.buyingGroupCommitment.findMany({
    where: { userId: uid },
    orderBy: [{ status: 'asc' }, { expiryDay: 'asc' }],
    include: {
      orderLinks: {
        include: {
          order: { select: { id: true, orderNumber: true, platform: true, orderDate: true, trackingNumbers: true, cost: true } },
        },
      },
    },
  });

  // When the carrier delivered each linked tracking number (lib/carrierPage.ts), for the late-scan line.
  const numbers = new Set<string>();
  for (const c of rows) for (const l of c.orderLinks) for (const n of String(l.order.trackingNumbers ?? '').split(',')) if (carrierKey(n)) numbers.add(carrierKey(n));
  const delivered = numbers.size
    ? await prisma.carrierDelivery.findMany({ where: { userId: uid, trackingNumber: { in: [...numbers] }, deliveredAt: { not: null } }, select: { trackingNumber: true, deliveredAt: true } })
    : [];
  const deliveredAt = new Map(delivered.map(d => [d.trackingNumber, d.deliveredAt as Date]));

  const now = new Date();
  const commitments = rows.map(c => {
    // assigned = total quantity across all orderLinks. fulfilled is a
    // SUBSET of assigned (BG counts an orderLink as fulfilled once
    // they've received it; the link row stays in the DB). So the
    // truthful slot usage is just `assigned` — NOT `assigned + fulfilled`.
    // Open slots = count - assigned. In-transit = assigned - fulfilled.
    const assigned = c.orderLinks.reduce((s, l) => s + l.quantity, 0);
    const inTransit = Math.max(0, assigned - c.fulfilled);
    const open = Math.max(0, c.count - assigned);
    const overCommit = assigned > c.count;
    const remaining = open;
    // "Short" means the commitment has open slots and is still in a state
    // where we could fill them — covers both ACTIVE and PARTIALLY FULFILLED.
    // expiryDay is a calendar day (midnight UTC): open through the whole day.
    const isShort = (c.status === 'ACTIVE' || c.status === 'PARTIALLY FULFILLED') && remaining > 0 && !!c.expiryDay && !isExpiryDayPast(c.expiryDay, Date.now());
    // Tiered payouts (lib/bgPayoutTiers.ts): the faster tier an open commitment can still reach, and a
    // fulfilled one BG still pays below the tier it earned (only once the sync has alerted on it).
    const tiers = bgPayoutTiers(c.raw);
    const reach = c.status === 'ACTIVE' || c.status === 'PARTIALLY FULFILLED' ? reachableTier(tiers, c.commission, now) : null;
    const owed = c.tierShortAt && c.fulfilledAt ? underpaidTier(tiers, c.commission, c.fulfilledAt) : null;
    // The last linked delivery is the one BG's fulfilled date waited on. Only known once every tracking number of
    // every linked order has a delivered date, so a partly known set never produces a late-scan line.
    const linked = new Map<number, string[]>();
    for (const l of c.orderLinks) {
      linked.set(l.order.id, String(l.order.trackingNumbers ?? '').split(',').map(carrierKey).filter(Boolean));
    }
    const carrierDelivered = lastDelivery([...linked.values()], n => deliveredAt.get(n));
    const mm = carrierDelivered && c.fulfilledAt ? tierMismatch({ tiers, deliveredAt: carrierDelivered, scannedAt: c.fulfilledAt, paidCommission: c.commission }) : null;
    const carrierLine = mm?.late && carrierDelivered && c.fulfilledAt ? carrierScanLine(carrierDelivered, c.fulfilledAt) : null;
    return {
      id: c.id,
      commitmentId: c.commitmentId,
      dealId: c.dealId,
      dealTitle: c.dealTitle,
      itemImage: c.itemImage,
      count: c.count,
      fulfilled: c.fulfilled,
      assigned,
      inTransit,
      open,
      overCommit,
      remaining,
      isShort,
      expiryDay: c.expiryDay?.toISOString() ?? null,
      price: c.price,
      commission: c.commission,
      total: c.total,
      status: c.status,
      tier: reach && {
        label: reach.label,
        unit: reach.price + reach.commission,
        deliverBy: reach.deliverBy.toISOString(),
        extra: (reach.commission - c.commission) * Math.max(0, c.count - c.fulfilled),
      },
      tierShort: owed && {
        label: owed.label,
        unit: owed.price + owed.commission,
        short: (owed.commission - c.commission) * c.fulfilled,
      },
      carrierLine,
      lastSyncedAt: c.lastSyncedAt.toISOString(),
      orderLinks: c.orderLinks.map(l => ({
        id: l.id,
        quantity: l.quantity,
        order: l.order,
      })),
    };
  });

  return Response.json({ commitments });
}
