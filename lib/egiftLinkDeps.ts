import { prisma } from '@/lib/db';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { upsertOrderEgiftLink } from '@/lib/egiftLinkStore';
import { encryptSetting, decryptSetting } from '@/lib/secrets';
import type { EgiftDeps } from '@/lib/egiftLinkApi';

// The real dependencies of lib/egiftLinkApi.ts, shared by the /api/orders/[id]/egift-link route and the
// email ingest, so a link saved from an email goes through exactly the same validation, hashing,
// encryption and order-lock checks as one pasted by hand.
export function makeEgiftDeps(getSessionUserId: () => Promise<number | null | undefined>): EgiftDeps {
  return {
    getSessionUserId,
    orderVisibleTo: async (orderId, userId) =>
      !!(await prisma.order.findFirst({
        where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
        select: { id: true },
      })),
    requireOrderUnlocked,
    findLink: (orderId) =>
      prisma.orderEgiftLink.findUnique({
        where: { orderId },
        select: { linkEnc: true, updatedAt: true },
      }),
    upsertLink: upsertOrderEgiftLink,
    deleteLink: (orderId) => prisma.orderEgiftLink.deleteMany({ where: { orderId } }),
    encrypt: encryptSetting,
    decrypt: decryptSetting,
  };
}
