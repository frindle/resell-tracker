import { prisma, getSetting } from '@/lib/db';
import { getBgAccessToken } from '@/lib/bgAuth';
import { submitTracking as bgSubmitTracking } from '@/lib/buyinggroup';
import { submitTracking as bsSubmitTracking } from '@/lib/bigsky';
import { logApiError } from '@/lib/apiErrorLog';

// Fires the same BG/BigSky tracking-submission flow used by /api/import,
// but for an arbitrary set of order IDs. Used by:
//   - /api/import after a scrape
//   - /api/orders/[id] PATCH when trackingNumbers changes
//
// Returns silently on failure — caller treats it as fire-and-forget. All
// failures land in the docker logs under "[bg-submit]".
export async function autoSubmitTrackingForOrders(
  userId: number | null,
  orderIds: number[],
  label = 'auto',
): Promise<void> {
  if (orderIds.length === 0) return;
  try {
    const ordersWithBuyers = await prisma.order.findMany({
      where: { id: { in: orderIds }, trackingSubmittedToBg: false, trackingNumbers: { not: null } },
      include: { buyer: true, bfmrLinks: { include: { reservation: true } } },
    });
    console.log(`[bg-submit/${label}] candidates after DB filter: ${ordersWithBuyers.length} of ${orderIds.length}`);
    if (ordersWithBuyers.length === 0) return;

    const bgTrackings: string[] = [];
    const bsTrackings: string[] = [];
    const bgOrderIds: number[] = [];
    const bsOrderIds: number[] = [];
    // BFMR: trackingMap is keyed by BFMR's order_id since that's what
    // bfmrWeb.submitTracking expects. Only auto-submit when the order
    // has exactly one BFMR reservation linked AND that reservation
    // has no existing tracking. Multi-shipment cases need the review
    // UI (task #15) before auto-submit is safe.
    const bfmrTrackingMap: Record<string, string[]> = {};
    const bfmrOrderIds: number[] = [];

    for (const order of ordersWithBuyers) {
      if (!order.trackingNumbers) continue;
      const trackings = order.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
      const buyerName = order.buyer?.name?.toLowerCase() ?? '';
      if (buyerName.includes('buyinggroup') || buyerName.includes('buying group')) {
        bgTrackings.push(...trackings);
        bgOrderIds.push(order.id);
        console.log(`[bg-submit/${label}] BG: order ${order.id} #${order.orderNumber} → ${trackings.join(', ')}`);
      } else if (buyerName.includes('bigsky') || buyerName.includes('big sky')) {
        bsTrackings.push(...trackings);
        bsOrderIds.push(order.id);
        console.log(`[bg-submit/${label}] BS: order ${order.id} #${order.orderNumber} → ${trackings.length} tracking(s)`);
      } else if (buyerName.includes('bfmr')) {
        // Single-shipment safety: skip orders with multiple linked
        // reservations or reservations that already have tracking.
        const reservationsWithoutTracking = order.bfmrLinks.filter(l => !l.reservation.trackingNumber);
        if (reservationsWithoutTracking.length === 0) {
          console.log(`[bg-submit/${label}] BFMR: order ${order.id} #${order.orderNumber} — all reservations already have tracking, skip`);
        } else if (order.bfmrLinks.length > 1) {
          console.log(`[bg-submit/${label}] BFMR: order ${order.id} #${order.orderNumber} — ${order.bfmrLinks.length} reservations, needs split-shipment review, skip`);
        } else if (!reservationsWithoutTracking[0].reservation.bfmrOrderId) {
          console.log(`[bg-submit/${label}] BFMR: order ${order.id} #${order.orderNumber} — reservation has no bfmrOrderId, skip`);
        } else {
          const bfmrOrderId = reservationsWithoutTracking[0].reservation.bfmrOrderId;
          bfmrTrackingMap[bfmrOrderId] = trackings;
          bfmrOrderIds.push(order.id);
          console.log(`[bg-submit/${label}] BFMR: order ${order.id} #${order.orderNumber} → bfmrOrderId=${bfmrOrderId}, ${trackings.length} tracking(s)`);
        }
      } else {
        console.log(`[bg-submit/${label}] skip order ${order.id} #${order.orderNumber}: buyer="${order.buyer?.name ?? '(none)'}" doesn't match BG/BS/BFMR`);
      }
    }

    const submittedIds: number[] = [];

    if (bgTrackings.length > 0) {
      try {
        const token = await getBgAccessToken(userId);
        await bgSubmitTracking(token, bgTrackings);
        console.log(`[bg-submit/${label}] BG submit OK for orders ${bgOrderIds.join(',')}`);
        submittedIds.push(...bgOrderIds);
      } catch (e) {
        console.error(`[bg-submit/${label}] BG submit FAILED: ${String(e).slice(0, 400)}`);
        void logApiError({
          userId, group: 'BG', endpoint: 'submitTracking', method: 'POST',
          body: String(e).slice(0, 1000),
          context: `auto-submit/${label} · orders ${bgOrderIds.join(',')}`,
        });
      }
    }

    if (bsTrackings.length > 0) {
      try {
        const cookieSetting = await getSetting(userId, 'bigsky_cookie');
        if (cookieSetting?.value) {
          await bsSubmitTracking(cookieSetting.value, bsTrackings);
          console.log(`[bg-submit/${label}] BS submit OK for orders ${bsOrderIds.join(',')}`);
          submittedIds.push(...bsOrderIds);
        } else {
          console.warn(`[bg-submit/${label}] BS submit skipped: no bigsky_cookie configured`);
        }
      } catch (e) {
        console.error(`[bg-submit/${label}] BS submit FAILED: ${String(e).slice(0, 400)}`);
        void logApiError({
          userId, group: 'BigSky', endpoint: 'submitTracking', method: 'POST',
          body: String(e).slice(0, 1000),
          context: `auto-submit/${label} · orders ${bsOrderIds.join(',')}`,
        });
      }
    }

    if (Object.keys(bfmrTrackingMap).length > 0) {
      try {
        const [emailSetting, passwordSetting] = await Promise.all([
          getSetting(userId, 'bfmr_email'),
          getSetting(userId, 'bfmr_password'),
        ]);
        if (emailSetting?.value && passwordSetting?.value) {
          const { submitTracking: bfmrSubmit } = await import('@/lib/bfmrWeb');
          await bfmrSubmit(emailSetting.value, passwordSetting.value, bfmrTrackingMap, userId);
          console.log(`[bg-submit/${label}] BFMR submit OK for orders ${bfmrOrderIds.join(',')}`);
          submittedIds.push(...bfmrOrderIds);
        } else {
          console.warn(`[bg-submit/${label}] BFMR submit skipped: no bfmr credentials configured`);
        }
      } catch (e) {
        console.error(`[bg-submit/${label}] BFMR submit FAILED: ${String(e).slice(0, 400)}`);
        void logApiError({
          userId, group: 'BFMR', endpoint: 'my-tracker submitTracking', method: 'POST',
          body: String(e).slice(0, 1000),
          context: `auto-submit/${label} · orders ${bfmrOrderIds.join(',')}`,
        });
      }
    }

    if (submittedIds.length > 0) {
      await prisma.order.updateMany({
        where: { id: { in: submittedIds } },
        data: { trackingSubmittedToBg: true },
      });
    }
  } catch (e) {
    console.error(`[bg-submit/${label}] unexpected error: ${String(e).slice(0, 400)}`);
  }
}
