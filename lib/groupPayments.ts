// Group payments the sync code already sees (CardCenter's payment list and detail): the payment's name, day, total and the
// orders it paid. Stored so the Books bank matcher can match a deposit to exactly those orders. No API call lives here.
import { prisma } from '@/lib/db';
import { commonBuyerId } from './groupPaymentDay.ts';

export { paymentDay, commonBuyerId } from './groupPaymentDay.ts';

/**
 * Save (or refresh) one payment with the orders it paid, `amountByOrder` in dollars. The order list is replaced each time, so a
 * payment CC re-prices stays current. Nothing is saved without a total, a day and at least one order.
 */
export async function recordGroupPayment(
  userId: number, group: string, ref: string, totalDollars: number, day: string | null, amountByOrder: Map<number, number>,
): Promise<void> {
  const amountCents = Math.round(totalDollars * 100);
  if (!day || !(amountCents > 0) || amountByOrder.size === 0) return;
  const orders = await prisma.order.findMany({ where: { userId, id: { in: [...amountByOrder.keys()] } }, select: { id: true, buyerId: true } });
  const buyerId = commonBuyerId(orders.map(o => o.buyerId));
  const rows = orders.map(o => ({ orderId: o.id, amountCents: Math.round(amountByOrder.get(o.id)! * 100) }));
  await prisma.$transaction(async tx => {
    const pay = await tx.groupPayment.upsert({
      where: { userId_group_externalRef: { userId, group, externalRef: ref } },
      update: { buyerId, amountCents, paidDate: day },
      create: { userId, group, externalRef: ref, buyerId, amountCents, paidDate: day },
    });
    await tx.groupPaymentOrder.deleteMany({ where: { paymentId: pay.id } });
    await tx.groupPaymentOrder.createMany({ data: rows.map(r => ({ paymentId: pay.id, ...r })) });
  });
}
