// Server glue for the "Orders with no card charge" list on the Shortfalls tab. Reads only.
import { prisma } from '../../db';
import { formatOrderDateIso } from '../../formatOrderDate.ts';
import { todayLA } from '../service.ts';
import { orderChargeTotals } from './posting.ts';
import { findUncharged, type UnchargedOrder } from './uncharged.ts';

export type UnchargedView = { rows: (UnchargedOrder & { cardName: string })[]; unlinked: number };

export async function unchargedView(userId: number, goLive: string): Promise<UnchargedView> {
  const [orders, accts, cards, charged] = await Promise.all([
    prisma.order.findMany({ where: { userId, cancelled: false, cardId: { not: null } } }),
    prisma.bankAccount.findMany({ where: { userId, creditCardId: { not: null } }, select: { id: true, creditCardId: true } }),
    prisma.creditCard.findMany({ where: { userId }, select: { id: true, name: true } }),
    orderChargeTotals(userId),
  ]);
  const firsts = await prisma.bankTransaction.groupBy({ by: ['bankAccountId'], where: { userId, bankAccountId: { in: accts.map(a => a.id) } }, _min: { postedDate: true } });
  const first = new Map(firsts.map(f => [f.bankAccountId, f._min.postedDate]));
  const feedStart = new Map<number, string | null>();
  for (const a of accts) {
    const s = first.get(a.id) ?? null, cur = feedStart.get(a.creditCardId!);
    feedStart.set(a.creditCardId!, cur === undefined ? s : s === null ? cur : cur === null || s < cur ? s : cur);
  }
  const { rows, unlinked } = findUncharged(
    orders.map(o => ({
      id: o.id, platform: o.platform, orderNumber: o.orderNumber, orderDate: formatOrderDateIso(o.orderDate), cardId: o.cardId,
      cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost, taxAmount: o.taxAmount, subtotalAmount: o.subtotalAmount,
      cancelled: o.cancelled, item: o.itemDescription,
    })),
    charged, feedStart, goLive, todayLA(),
  );
  const names = new Map(cards.map(c => [c.id, c.name]));
  return { rows: rows.map(r => ({ ...r, cardName: names.get(r.cardId) ?? `Card ${r.cardId}` })), unlinked };
}
