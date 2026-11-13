// What draftFromPhoto / prefillFromPhoto need to recognise a store, gift card
// brand and payment card: the user's own plus common defaults.
import { prisma } from '@/lib/db';
import type { DraftCtx } from '@/lib/photoDraft';

const DEFAULT_PLATFORMS = ['Amazon', 'Walmart', 'Costco', 'Best Buy', 'Target'];
const DEFAULT_BRANDS = ['Amazon', 'Apple', 'Best Buy', 'Target', 'Walmart', 'Home Depot', 'Lowe\'s', 'Visa', 'Mastercard', 'Uber', 'DoorDash', 'Starbucks', 'Nike', 'Sephora', 'Airbnb', 'Southwest'];

export async function loadDraftCtx(uid: number): Promise<DraftCtx> {
  const [platformRows, merchantRows, cards, pastItems] = await Promise.all([
    prisma.order.findMany({ where: { userId: uid }, select: { platform: true }, distinct: ['platform'] }),
    prisma.giftCard.findMany({ where: { order: { userId: uid } }, select: { merchant: true }, distinct: ['merchant'] }),
    prisma.creditCard.findMany({ where: { userId: uid }, select: { id: true, last4: true, lastFours: { select: { last4: true } } } }),
    // Recent items with a dollar amount ("$50 Doordash GC"), for a new gift card order's face value.
    prisma.order.findMany({
      where: { userId: uid, itemDescription: { contains: '$' } },
      select: { platform: true, itemDescription: true }, orderBy: { orderDate: 'desc' }, take: 200,
    }),
  ]);
  return {
    platforms: [...new Set([...DEFAULT_PLATFORMS, ...platformRows.map(r => r.platform)])],
    merchants: [...new Set([...DEFAULT_BRANDS, ...merchantRows.map(r => r.merchant)])],
    cards: cards.map(c => ({ id: c.id, last4s: [c.last4, ...c.lastFours.map(l => l.last4)].filter((x): x is string => !!x) })),
    pastItems: pastItems.filter((p): p is { platform: string; itemDescription: string } => !!p.itemDescription),
  };
}
