// Records a group's payment email as a group payment. With every tracking number resolved to an order and the lines adding up
// to the total, the payment is stored with exact per-order cents (the Books matcher then links a deposit to exactly those
// orders); otherwise only its total, and the caller is told how many lines did not resolve. The same ref updates in place.
import { prisma } from '@/lib/db';
import { commonBuyerId } from '@/lib/groupPaymentDay';
import { recordGroupPayment, recordGroupPaymentTotal } from '@/lib/groupPayments';
import { planRemittance, trackingIndex, pickOwner } from '@/lib/groupRemittancePlan';
import type { RemittanceLine } from '@/lib/remittanceParse';

export type RemittanceInput = { group: string; ref: string; totalCents: number; paidDay: string; lines: RemittanceLine[] };
export type RemittanceResult = { exact: boolean; resolved: number; unresolved: number; recorded: boolean };

const orderRows = (userId: number) => prisma.order.findMany({ where: { userId, trackingNumbers: { not: null } }, select: { id: true, trackingNumbers: true, buyerId: true } });

/** Record one payment for a user. Nothing is stored without a ref, a day and a positive total. */
export async function recordRemittance(userId: number, input: RemittanceInput): Promise<RemittanceResult> {
  const { group, ref, totalCents, paidDay, lines } = input;
  if (!ref || !paidDay || !(totalCents > 0)) return { exact: false, resolved: 0, unresolved: lines.length, recorded: false };
  const orders = await orderRows(userId);
  const plan = planRemittance(totalCents, lines, trackingIndex(orders));
  if (plan.exact) {
    await recordGroupPayment(userId, group, ref, totalCents / 100, paidDay, new Map([...plan.amounts].map(([id, c]) => [id, c / 100])));
  } else {
    const buyerBy = new Map(orders.map(o => [o.id, o.buyerId]));
    await recordGroupPaymentTotal(userId, group, ref, totalCents / 100, paidDay, commonBuyerId(plan.orderIds.map(id => buyerBy.get(id) ?? null)));
    // an earlier exact version of this payment must not keep stale order rows
    await prisma.groupPaymentOrder.deleteMany({ where: { payment: { userId, group, externalRef: ref } } });
  }
  return { exact: plan.exact, resolved: plan.resolved, unresolved: plan.unresolved, recorded: true };
}

/**
 * Record a payment email for whichever user it belongs to: the user most of its tracking numbers resolve for. When none
 * resolves, the only user (single-user installs) gets the total; with several users it is left alone.
 */
export async function recordRemittanceForOwner(input: RemittanceInput): Promise<(RemittanceResult & { userId: number }) | null> {
  const users = await prisma.user.findMany({ select: { id: true } });
  const resolvedBy = new Map<number, number>();
  for (const u of users) resolvedBy.set(u.id, planRemittance(input.totalCents, input.lines, trackingIndex(await orderRows(u.id))).resolved);
  const owner = pickOwner(resolvedBy) ?? (users.length === 1 ? users[0].id : null);
  if (owner == null) return null;
  return { ...(await recordRemittance(owner, input)), userId: owner };
}
