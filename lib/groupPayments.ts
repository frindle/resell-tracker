// Group payments the sync code already sees (CardCenter's payment list and detail): the payment's name, day, total and the
// orders it paid. Stored so the Books bank matcher can match a deposit to exactly those orders. No API call lives here.
import { prisma } from '@/lib/db';

/** The day a payment was made: its receivedOn, else the date inside a name like "P1056-20260709". null when neither is usable. */
export function paymentDay(receivedOn: string | null | undefined, name: string): string | null {
  const iso = receivedOn?.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const m = name.match(/^P\d+-(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The buyer most of the orders belong to (ties: the lowest id); null when none has a buyer. */
export function commonBuyerId(buyerIds: (number | null)[]): number | null {
  const n = new Map<number, number>();
  for (const b of buyerIds) if (b != null) n.set(b, (n.get(b) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

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
