import { prisma } from '@/lib/db';
import { parseUserEditedFields } from '@/lib/orderFieldSync';
import { planLinkedSync, type LinkGroup, type LinkedTitle } from './linkedItems.ts';

/**
 * Copies the linked reservation/commitment titles onto an order and fills in
 * its buyer (see lib/linkedItems.ts). Called after any link on the order is
 * created, changed or removed. Never throws: a failure here must not undo a
 * link that was saved.
 */
export async function syncOrderFromLinks(orderId: number): Promise<{ itemDescription?: string; buyerId?: number }> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        itemDescription: true, buyerId: true, userEditedFields: true, locked: true, cancelled: true,
        bfmrLinks: { orderBy: { id: 'asc' }, select: { quantity: true, reservation: { select: { itemName: true, dealTitle: true } } } },
        commitmentLinks: { orderBy: { id: 'asc' }, select: { quantity: true, commitment: { select: { dealTitle: true } } } },
        bigSkyLinks: { orderBy: { id: 'asc' }, select: { quantity: true, commitment: { select: { itemName: true } } } },
      },
    });
    if (!order) return {};
    const links: LinkedTitle[] = [
      ...order.bfmrLinks.map(l => ({ group: 'BFMR' as const, title: l.reservation.itemName || l.reservation.dealTitle, quantity: l.quantity })),
      ...order.commitmentLinks.map(l => ({ group: 'BuyingGroup' as const, title: l.commitment.dealTitle, quantity: l.quantity })),
      ...order.bigSkyLinks.map(l => ({ group: 'BigSkyBuyers' as const, title: l.commitment.itemName, quantity: l.quantity })),
    ];
    if (links.length === 0) return {};

    const buyers = order.buyerId == null ? await prisma.buyer.findMany({ select: { id: true, name: true } }) : [];
    const buyerIdFor = (group: LinkGroup): number | null =>
      (buyers.find(b => b.name === group) ?? buyers.find(b => b.name.toLowerCase().includes(group.toLowerCase())))?.id ?? null;

    const data = planLinkedSync(
      {
        itemDescription: order.itemDescription,
        buyerId: order.buyerId,
        userEditedFields: parseUserEditedFields(order.userEditedFields),
        locked: order.locked,
        cancelled: order.cancelled,
      },
      links,
      buyerIdFor,
    );
    if (Object.keys(data).length > 0) await prisma.order.update({ where: { id: orderId }, data });
    return data;
  } catch (e) {
    console.error(`[linked-items] order=${orderId} sync failed: ${String(e).slice(0, 200)}`);
    return {};
  }
}
