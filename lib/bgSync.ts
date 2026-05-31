import { prisma } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts } from '@/lib/buyinggroup';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function runBgReceiptSync() {
  try {
    // Find all users with BuyingGroup configured
    const users = await prisma.user.findMany({ select: { id: true } });

    for (const user of users) {
      const configured = await isBgConfigured(user.id);
      if (!configured) continue;

      try {
        const token = await getBgAccessToken(user.id);

        const allReceipts: unknown[] = [];
        let page = 1;
        while (true) {
          const data = await getReceipts(token, page, 50);
          const d = data as Record<string, unknown>;
          const payload = d.payload as Record<string, unknown> | undefined;
          const items = (Array.isArray(data) ? data : (payload?.receipts ?? d.results ?? d.data ?? [])) as unknown[];
          if (!items.length) break;
          allReceipts.push(...items);
          if (items.length < 50) break;
          page++;
        }

        const orders = await prisma.order.findMany({
          where: { userId: user.id },
          select: { id: true, orderNumber: true, salePrice: true, trackingNumbers: true, overdueAt: true },
        });

        // Build lookup maps for matching
        const byOrderNum = new Map(orders.filter(o => o.orderNumber).map(o => [normalize(o.orderNumber), o]));
        const byTracking = new Map<string, typeof orders[0]>();
        for (const o of orders) {
          if (!o.trackingNumbers) continue;
          for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
            byTracking.set(normalize(t), o);
          }
        }

        const paidOrderIds = new Set<number>();
        let updated = 0;
        for (const raw of allReceipts) {
          const r = raw as Record<string, unknown>;
          const orderNum = normalize(String(r.order_number ?? r.receipt_id ?? r.key ?? ''));
          const receiptTracking = normalize(String(r.tracking_number ?? ''));

          const salePrice = parseFloat(String(r.total_paid ?? r.cashback_amount ?? 0)) || null;
          const tracking = String(r.tracking_number ?? '').trim() || null;

          // Match by order number first, then fall back to tracking number
          const match = (orderNum ? byOrderNum.get(orderNum) : null) ?? (receiptTracking ? byTracking.get(receiptTracking) : null);
          if (!match) continue;

          paidOrderIds.add(match.id);

          const updateData: Record<string, unknown> = {};
          if (salePrice && !match.salePrice) updateData.salePrice = salePrice;
          if (tracking && !match.trackingNumbers) updateData.trackingNumbers = tracking;
          // Clear overdue flag if now paid
          if (match.overdueAt) updateData.overdueAt = null;
          if (!Object.keys(updateData).length) continue;

          await prisma.order.update({ where: { id: match.id }, data: updateData });
          updated++;
        }

        // Flag orders overdue: platform order, no sale price, no receipt match, placed >14 days ago
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const overdueOrders = orders.filter(o =>
          !o.salePrice &&
          !paidOrderIds.has(o.id) &&
          !o.overdueAt
        );
        if (overdueOrders.length > 0) {
          const fullOrders = await prisma.order.findMany({
            where: { id: { in: overdueOrders.map(o => o.id) }, platform: { in: ['Walmart', 'Amazon'] }, orderDate: { lt: cutoff } },
            select: { id: true },
          });
          for (const o of fullOrders) {
            await prisma.order.update({ where: { id: o.id }, data: { overdueAt: new Date() } });
          }
          if (fullOrders.length > 0) console.log(`[BG sync] user ${user.id}: flagged ${fullOrders.length} overdue orders`);
        }

        if (updated > 0) console.log(`[BG sync] user ${user.id}: updated ${updated} orders`);
      } catch (e) {
        console.error(`[BG sync] user ${user.id} failed:`, e);
      }
    }
  } catch (e) {
    console.error('[BG sync] fatal:', e);
  }
}
