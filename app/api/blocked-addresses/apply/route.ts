import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

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
        ignoredByRule: false,
      },
      select: { id: true, platform: true, shippingAddress: true, buyerId: true },
    }),
  ]);

  const pickupIgnorePlatforms: string[] = (() => {
    try { return JSON.parse(pickupSetting?.value ?? '[]'); } catch { return []; }
  })();

  const addressFlagIds = blockedPatterns.length
    ? orders
        .filter(o => o.shippingAddress && blockedPatterns.some(b => o.shippingAddress!.toLowerCase().includes(b.pattern.toLowerCase())))
        .map(o => o.id)
    : [];
  const addressFlagSet = new Set(addressFlagIds);

  // Pickup-ignore: no shipping address AND no buyer, on an opted-in
  // platform. Both signals required — a real resale order always has a
  // shipping address even before a buyer is assigned.
  const pickupFlagIds = pickupIgnorePlatforms.length
    ? orders
        .filter(o => !addressFlagSet.has(o.id) && !o.shippingAddress && o.buyerId == null && pickupIgnorePlatforms.includes(o.platform))
        .map(o => o.id)
    : [];

  if (addressFlagIds.length) {
    await prisma.order.updateMany({
      where: { id: { in: addressFlagIds } },
      data: { ignoredByRule: true },
    });
  }
  if (pickupFlagIds.length) {
    await prisma.order.updateMany({
      where: { id: { in: pickupFlagIds } },
      data: { ignoredByRule: true, blockedAddressPattern: PICKUP_IGNORE_PATTERN },
    });
  }

  return Response.json({ flagged: addressFlagIds.length + pickupFlagIds.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
