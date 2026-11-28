// Stores BFMR's own payment days as group payments so the Books deposit matcher links a BFMR deposit to exactly that day's
// orders instead of searching subsets. Reads the BFMR reservations the sync already saved; no API call.
import { prisma } from '@/lib/db';
import { loadBfmrPaid } from '@/lib/books/bank/payoutOrders';
import { bfmrDayPayments } from '@/lib/groupPaymentDay';
import { recordGroupPayment, recordGroupPaymentTotal } from '@/lib/groupPayments';

/** Record every recent BFMR paid day (idempotent). Returns how many days were stored with orders and how many as a total only. */
export async function recordBfmrPaymentGroups(userId: number): Promise<{ exact: number; totalOnly: number }> {
  const { batches } = await loadBfmrPaid(userId);
  const buyerOf = new Map(batches.map(b => [b.ref, b.buyerId]));
  let exact = 0, totalOnly = 0;
  for (const p of bfmrDayPayments(batches)) {
    if (p.exact) {
      await recordGroupPayment(userId, 'bfmr', p.ref, p.amountCents / 100, p.day, new Map(p.orders.map(o => [o.orderId, o.cents / 100])));
      exact++;
    } else {
      await recordGroupPaymentTotal(userId, 'bfmr', p.ref, p.amountCents / 100, p.day, buyerOf.get(`bfmr:${p.day}`) ?? null);
      // a day that was exact before and no longer is must not keep stale order rows
      await prisma.groupPaymentOrder.deleteMany({ where: { payment: { userId, group: 'bfmr', externalRef: p.ref } } });
      totalOnly++;
    }
  }
  return { exact, totalOnly };
}
