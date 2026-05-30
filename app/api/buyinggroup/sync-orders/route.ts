import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts } from '@/lib/buyinggroup';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const configured = await isBgConfigured(userId);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  try {
    const token = await getBgAccessToken(userId);

    // Fetch all receipt pages until empty
    const allReceipts = [];
    let page = 1;
    while (true) {
      const data = await getReceipts(token, page, 50);
      const d = data as Record<string, unknown>;
      const payload = d.payload as Record<string, unknown> | undefined;
      const items = Array.isArray(data) ? data : (payload?.receipts ?? d.results ?? d.data ?? []) as unknown[];
      if (!items.length) break;
      allReceipts.push(...items);
      if (items.length < 50) break;
      page++;
    }

    let updated = 0;
    for (const raw of allReceipts) {
      const r = raw as Record<string, unknown>;
      const orderNum = normalize(String(r.order_number ?? r.receipt_id ?? r.key ?? ''));
      if (!orderNum) continue;

      const salePrice = parseFloat(String(r.total_paid ?? r.cashback_amount ?? 0)) || null;
      const tracking = String(r.tracking_number ?? '').trim() || null;

      if (!salePrice && !tracking) continue;

      // Find matching order by normalized order number
      const orders = await prisma.order.findMany({
        where: { userId },
        select: { id: true, orderNumber: true, salePrice: true, trackingNumbers: true },
      });

      const match = orders.find(o => normalize(o.orderNumber) === orderNum);
      if (!match) continue;

      const updateData: Record<string, unknown> = {};
      if (salePrice && !match.salePrice) updateData.salePrice = salePrice;
      if (tracking && !match.trackingNumbers) updateData.trackingNumbers = tracking;

      if (Object.keys(updateData).length > 0) {
        await prisma.order.update({ where: { id: match.id }, data: updateData });
        updated++;
      }
    }

    return Response.json({ synced: allReceipts.length, updated });
  } catch (e) {
    console.error('[BG sync-orders]', e);
    return new Response(String(e), { status: 502 });
  }
}
