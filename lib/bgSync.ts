import { prisma } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts } from '@/lib/buyinggroup';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function runBgReceiptSync(force = false) {
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
          select: { id: true, orderNumber: true, salePrice: true, salePriceSynced: true, trackingNumbers: true, overdueAt: true },
        });

        // Build lookup map by tracking number (BG has no Walmart/Amazon order number)
        const byTracking = new Map<string, typeof orders[0]>();
        for (const o of orders) {
          if (!o.trackingNumbers) continue;
          for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
            byTracking.set(normalize(t), o);
          }
        }

        const paidOrderIds = new Set<number>();
        const receiptOverdueIds = new Set<number>();
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        let updated = 0;

        for (const raw of allReceipts) {
          const r = raw as Record<string, unknown>;
          const trackingObj = r.tracking as Record<string, unknown> | null | undefined;
          const trackingId = normalize(String(trackingObj?.tracking_id ?? ''));
          if (!trackingId) continue;

          const match = byTracking.get(trackingId);
          if (!match) continue;

          const isPaid = r.paid === true;
          // total = what BG reimburses; equals total_paid once paid
          const salePrice = parseFloat(String(r.total ?? 0)) || null;

          if (isPaid) {
            paidOrderIds.add(match.id);
          } else {
            // Overdue: submitted >14 days ago and still unpaid
            const createdRaw = String(r.created_dt ?? '');
            const createdAt = createdRaw ? new Date(createdRaw) : null;
            if (createdAt && createdAt < cutoff) receiptOverdueIds.add(match.id);
          }

          const updateData: Record<string, unknown> = {};
          if (isPaid && salePrice && (force || match.salePrice == null || match.salePriceSynced)) {
            updateData.salePrice = salePrice;
            updateData.salePriceSynced = true;
          }
          if (isPaid && match.overdueAt) updateData.overdueAt = null;
          if (!isPaid && receiptOverdueIds.has(match.id) && !match.overdueAt) updateData.overdueAt = new Date();
          if (!Object.keys(updateData).length) continue;

          await prisma.order.update({ where: { id: match.id }, data: updateData });
          updated++;
        }

        // Also flag orders with no BG receipt at all but old enough
        const overdueOrders = orders.filter(o =>
          !o.salePrice &&
          !paidOrderIds.has(o.id) &&
          !receiptOverdueIds.has(o.id) &&
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
