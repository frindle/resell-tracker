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
          select: { id: true, orderNumber: true, salePrice: true, trackingNumbers: true },
        });

        let updated = 0;
        for (const raw of allReceipts) {
          const r = raw as Record<string, unknown>;
          const orderNum = normalize(String(r.order_number ?? r.receipt_id ?? r.key ?? ''));
          if (!orderNum) continue;

          const salePrice = parseFloat(String(r.total_paid ?? r.cashback_amount ?? 0)) || null;
          const tracking = String(r.tracking_number ?? '').trim() || null;
          if (!salePrice && !tracking) continue;

          const match = orders.find(o => normalize(o.orderNumber) === orderNum);
          if (!match) continue;

          const updateData: Record<string, unknown> = {};
          if (salePrice && !match.salePrice) updateData.salePrice = salePrice;
          if (tracking && !match.trackingNumbers) updateData.trackingNumbers = tracking;
          if (!Object.keys(updateData).length) continue;

          await prisma.order.update({ where: { id: match.id }, data: updateData });
          updated++;
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
