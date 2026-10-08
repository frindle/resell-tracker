import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { upsertOrderEgiftLink } from '@/lib/egiftLinkStore';
import { encryptSetting, decryptSetting } from '@/lib/secrets';
import { handleGet, handlePut, handleDelete, type EgiftDeps } from '@/lib/egiftLinkApi';

// Thin wiring: all request logic (and its tests) lives in lib/egiftLinkApi.ts.
const deps: EgiftDeps = {
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

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handleGet(deps, req, (await params).id);
}

export async function PUT(req: Request, { params }: Ctx) {
  return handlePut(deps, req, (await params).id);
}

export async function DELETE(req: Request, { params }: Ctx) {
  return handleDelete(deps, req, (await params).id);
}
