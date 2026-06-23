import { prisma, getSetting } from '@/lib/db';
import { getBgAccessToken } from '@/lib/bgAuth';
import { submitTracking as bgSubmitTracking } from '@/lib/buyinggroup';
import { submitTracking as bsSubmitTracking } from '@/lib/bigsky';

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
      include: { buyer: true },
    });
    console.log(`[bg-submit/${label}] candidates after DB filter: ${ordersWithBuyers.length} of ${orderIds.length}`);
    if (ordersWithBuyers.length === 0) return;

    const bgTrackings: string[] = [];
    const bsTrackings: string[] = [];
    const bgOrderIds: number[] = [];
    const bsOrderIds: number[] = [];

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
      } else {
        console.log(`[bg-submit/${label}] skip order ${order.id} #${order.orderNumber}: buyer="${order.buyer?.name ?? '(none)'}" doesn't match BG/BS`);
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
