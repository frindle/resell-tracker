import { withBooks } from '@/lib/books/api';
import { getGoLive, todayLA } from '@/lib/books/service';
import { listOpenShortfalls, darkbloomView } from '@/lib/books/bank/payouts';
import { loadPayoutOrders } from '@/lib/books/bank/payoutOrders';
import { agingByBuyer } from '@/lib/books/payoutReview';
import { KNOWN_SHORTFALL } from '@/lib/books/orderPostings';

/**
 * The Shortfalls tab: open deposit shortfalls, paid orders waiting more than 21 days for a deposit (by buyer), the
 * payouts the sync already knew were short (list only), and the Darkbloom balance against payouts received by month.
 */
export async function GET() {
  return withBooks(async userId => {
    const goLive = await getGoLive(userId);
    const { all } = await loadPayoutOrders(userId);
    const brief = (o: (typeof all)[number]) => ({ orderId: o.orderId, orderNumber: o.orderNumber, platform: o.platform, item: o.itemDescription, buyer: o.buyerName, paidDay: o.paidDay, paidCents: o.paidCents, openCents: o.openCents });
    const names = new Map(all.map(o => [o.buyerId, o.buyerName]));
    return Response.json({
      deposits: await listOpenShortfalls(userId),
      aging: agingByBuyer(all, todayLA()).map(g => ({ ...g, buyer: names.get(g.buyerId) ?? null })),
      known: all.filter(o => o.finalPay && o.saleCents > o.paidCents).map(o => ({ ...brief(o), saleCents: o.saleCents, shortCents: o.saleCents - o.paidCents, memo: KNOWN_SHORTFALL })),
      darkbloom: await darkbloomView(userId, goLive),
    });
  });
}
