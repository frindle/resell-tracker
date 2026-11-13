import { withBooks } from '@/lib/books/api';
import { loadPayoutOrders } from '@/lib/books/bank/payoutOrders';

/** Paid orders still waiting for a deposit (the picker for a deposit that covers several orders). */
export async function GET() {
  return withBooks(async userId => {
    const { all } = await loadPayoutOrders(userId);
    return Response.json({
      payouts: all.filter(o => o.openCents > 0).sort((a, b) => b.paidDay.localeCompare(a.paidDay) || b.orderId - a.orderId)
        .map(o => ({ orderId: o.orderId, orderNumber: o.orderNumber, platform: o.platform, item: o.itemDescription, buyerId: o.buyerId, buyer: o.buyerName, paidDay: o.paidDay, paidCents: o.paidCents, openCents: o.openCents })),
    });
  });
}
