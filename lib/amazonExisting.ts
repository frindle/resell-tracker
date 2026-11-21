// Loads the tracker's stored Amazon orders in the shape lib/amazonCompare.ts
// compares against. Shared by the capture endpoint and the replay script.
import { prisma } from '@/lib/db';
import type { ExistingOrder } from '@/lib/amazonCompare';

const digits = (s: string) => s.replace(/\D/g, '');

export async function loadExistingAmazon(userId: number, nums: string[]): Promise<Map<string, ExistingOrder>> {
  const out = new Map<string, ExistingOrder>();
  if (!nums.length) return out;
  const rows = await prisma.order.findMany({
    where: { userId, platform: 'Amazon', orderNumber: { in: nums } },
    include: { card: { include: { lastFours: true } }, _count: { select: { attachments: true } } },
  });
  for (const o of rows) {
    if (!o.orderNumber) continue;
    out.set(digits(o.orderNumber), {
      id: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate, cost: o.cost,
      itemDescription: o.itemDescription, shippingAddress: o.shippingAddress,
      trackingNumbers: o.trackingNumbers, taxAmount: o.taxAmount, cardId: o.cardId,
      cardLast4s: o.card ? [o.card.last4, ...o.card.lastFours.map(l => l.last4)].filter((x): x is string => !!x) : [],
      noRushBonusPercent: o.noRushBonusPercent, locked: o.locked, cancelled: o.cancelled,
      userEditedFields: o.userEditedFields, hasPhoto: o._count.attachments > 0,
    });
  }
  return out;
}

export async function loadSavedCardLast4s(userId: number): Promise<Set<string>> {
  const cards = await prisma.creditCard.findMany({ where: { userId }, include: { lastFours: true } });
  return new Set(cards.flatMap(c => [c.last4, ...c.lastFours.map(l => l.last4)]).filter((x): x is string => !!x));
}
