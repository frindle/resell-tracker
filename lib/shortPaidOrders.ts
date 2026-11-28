// Orders BuyingGroup paid in full but under the expected payout (Order.bgShortPaid, set by lib/bgSync.ts).
// For the daily digest's "needs manual action" section: list `line` for each.
// Not wired in yet: the digest lives on branch digest-review-orders.
import { prisma } from '@/lib/db';
import { shortPaidLine } from '@/lib/bgShortPaid';

export async function shortPaidOrders(userId: number): Promise<{ id: number; orderNumber: string | null; short: number; line: string }[]> {
  const rows = await prisma.order.findMany({
    where: { userId, cancelled: false, lost: false, bgShortPaid: { gt: 0 } },
    select: { id: true, orderNumber: true, bgShortPaid: true },
    orderBy: { id: 'asc' },
  });
  return rows.map(r => ({ id: r.id, orderNumber: r.orderNumber, short: r.bgShortPaid!, line: shortPaidLine(r.orderNumber, r.id, r.bgShortPaid!) }));
}
