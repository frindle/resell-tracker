import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { encryptSetting } from '@/lib/secrets';
import { handleGet, handlePost, handleDelete, type MgcpDeps } from '@/lib/mgcpLinkApi';

// Thin wiring: request logic and tests live in lib/mgcpLinkApi.ts.
export const dynamic = 'force-dynamic';

const deps: MgcpDeps = {
  getSessionUserId,
  orderVisibleTo: async (orderId, userId) =>
    !!(await prisma.order.findFirst({
      where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
      select: { id: true },
    })),
  requireOrderUnlocked,
  listLinks: (orderId) =>
    prisma.orderMgcpLink.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, giftCardId: true, updatedAt: true },
    }),
  createLink: async (orderId, linkEnc, linkHash) => {
    const existing = await prisma.orderMgcpLink.findUnique({
      where: { orderId_linkHash: { orderId, linkHash } },
      select: { id: true },
    });
    if (existing) return false;
    await prisma.orderMgcpLink.create({ data: { orderId, linkEnc, linkHash } });
    return true;
  },
  deleteLink: (orderId, linkId) => prisma.orderMgcpLink.deleteMany({ where: { id: linkId, orderId } }),
  encrypt: encryptSetting,
};

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handleGet(deps, req, (await params).id);
}
export async function POST(req: Request, { params }: Ctx) {
  return handlePost(deps, req, (await params).id);
}
export async function DELETE(req: Request, { params }: Ctx) {
  return handleDelete(deps, req, (await params).id);
}
