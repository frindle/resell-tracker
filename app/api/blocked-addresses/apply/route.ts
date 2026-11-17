import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { planBlockedApply } from '@/lib/blockedApply';

// Sentinel stored in blockedAddressPattern for pickup-ignore matches (no
// address to record) — reuses the existing /orders/blocked review queue so
// these can be inspected/un-ignored the same way as address-blocked orders.
const PICKUP_IGNORE_PATTERN = 'No shipping address & no buyer (likely in-store pickup)';

export async function POST() {
  try {
  const userId = await getSessionUserId();

  const [blockedPatterns, pickupSetting, orders] = await Promise.all([
    prisma.blockedAddress.findMany({ select: { pattern: true } }),
    getSetting(userId ?? null, 'pickup_ignore_platforms'),
    prisma.order.findMany({
      where: {
        ...(userId ? { userId } : { userId: null }),
        platform: { in: ['Walmart', 'Amazon'] },
        skipAddressBlock: false,
        // Not already on the Blocked page. This also picks up orders an older
        // version hid without a pattern, so they get one and show there.
        blockedAddressPattern: null,
      },
      select: { id: true, platform: true, shippingAddress: true, buyerId: true },
    }),
  ]);

  const pickupIgnorePlatforms: string[] = (() => {
    try { return JSON.parse(pickupSetting?.value ?? '[]'); } catch { return []; }
  })();

  const plan = planBlockedApply(orders, blockedPatterns.map(b => b.pattern), pickupIgnorePlatforms, PICKUP_IGNORE_PATTERN);
  let flagged = 0;
  for (const [pattern, ids] of plan) {
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { ignoredByRule: true, blockedAddressPattern: pattern },
    });
    flagged += ids.length;
  }

  return Response.json({ flagged });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
