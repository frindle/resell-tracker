/**
 * ONE-TIME BACKFILL — do not wire into any route or cron.
 *
 * Catches up reservations that were FULLY submitted locally (sum of their
 * BfmrSubmittedShipment.qty >= reservation.qty) BEFORE the submit route started
 * promoting them: they still read 'purchased'/'reserved' in the status badge,
 * and their orders never rolled up to shipped.
 *
 * For each such reservation it sets status='shipped' (and trackingNumber from
 * the last recorded shipment when null), then re-runs recalcBfmrSalePrice for
 * every linked order — which now also promotes order.bfmrStatus to 'shipped'
 * when all sold links rank >= shipped.
 *
 * Guards (same invariants as the live code paths):
 *   - only reservations whose CURRENT status ranks BELOW shipped are touched —
 *     processed/paid/etc. already win and are left alone;
 *   - terminal statuses (cancelled/returned/set_aside/closed) are never touched;
 *   - cancelled orders are skipped entirely (recalcBfmrSalePrice also short-
 *     circuits on order.cancelled, but we don't even call it for them).
 *
 * Run once from the repo root with an alias-aware runner (lib/db.ts imports
 * via '@/…', so plain `node --experimental-strip-types` won't resolve it):
 *   npx prisma generate && npx tsx scripts/backfill-bfmr-shipped.ts
 */
import { prisma } from '../lib/db';
import { BFMR_STATUS_RANK, BFMR_TERMINAL_STATUSES } from '../lib/bfmr';
import { recalcBfmrSalePrice } from '../lib/bfmrSalePrice';

async function main() {
  const shippedRank = BFMR_STATUS_RANK['shipped'] ?? 0;

  // Candidates: reservations with at least one recorded shipment whose status
  // is non-terminal and ranks below shipped. (Already-shipped/paid rows are
  // excluded here so the update pass only ever promotes.)
  const candidates = await prisma.bfmrReservation.findMany({
    where: { submittedShipments: { some: {} } },
    select: {
      id: true,
      qty: true,
      status: true,
      trackingNumber: true,
      orderLinks: { select: { orderId: true } },
    },
  });

  const affectedOrderIds = new Set<number>();
  let updated = 0;

  for (const r of candidates) {
    const isTerminal = BFMR_TERMINAL_STATUSES.has(r.status.toLowerCase().trim());
    if (isTerminal) continue;
    if ((BFMR_STATUS_RANK[r.status] ?? 0) >= shippedRank) continue; // already at/above shipped — never downgrade

    const shipments = await prisma.bfmrSubmittedShipment.findMany({
      where: { reservationId: r.id },
      select: { qty: true, trackingNumber: true },
      orderBy: { id: 'asc' },
    });
    const submittedQty = shipments.reduce((s, x) => s + x.qty, 0);
    if (submittedQty < r.qty) continue; // not fully submitted — leave for the live path

    await prisma.bfmrReservation.update({
      where: { id: r.id },
      data: {
        status: 'shipped',
        trackingNumber: r.trackingNumber ?? shipments[shipments.length - 1].trackingNumber,
      },
    });
    updated++;
    console.log(`reservation ${r.id}: fully submitted (${submittedQty}/${r.qty}), was '${r.status}' → shipped`);

    for (const l of r.orderLinks) affectedOrderIds.add(l.orderId);
  }

  // Re-run the extended recalc per affected order, skipping cancelled ones.
  const orders = await prisma.order.findMany({
    where: { id: { in: [...affectedOrderIds] } },
    select: { id: true, cancelled: true },
  });
  let recalced = 0;
  for (const o of orders) {
    if (o.cancelled) {
      console.log(`order ${o.id}: skipped (cancelled)`);
      continue;
    }
    await recalcBfmrSalePrice(o.id);
    recalced++;
  }

  console.log(`backfill complete: ${updated} reservation(s) promoted, ${recalced} order(s) recalced (${orders.length - recalced} cancelled skipped)`);
  await prisma.$disconnect();
}

main().catch(e => {
  console.error('backfill failed:', e);
  process.exit(1);
});
