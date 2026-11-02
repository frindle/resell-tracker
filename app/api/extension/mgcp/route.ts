import { prisma } from '@/lib/db';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { decryptSetting } from '@/lib/secrets';
import { handleList, handleCapture, handleStatus, type CaptureDeps } from '@/lib/mgcpCaptureApi';
import { writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const FILES_DIR = '/data/files';

const deps: CaptureDeps = {
  authorize: (req) => resolveExtensionUserId(req, null),
  orderVisibleTo: async (orderId, userId) =>
    !!(await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } })),
  listOpenLinks: (orderId) =>
    prisma.orderMgcpLink.findMany({
      where: { orderId, status: { not: 'captured' } },
      orderBy: { id: 'asc' },
      select: { id: true, linkEnc: true, status: true },
    }),
  findLink: (orderId, linkId) =>
    prisma.orderMgcpLink.findFirst({ where: { id: linkId, orderId }, select: { id: true, linkEnc: true, status: true } }),
  setLinkStatus: (orderId, linkId, status) =>
    prisma.orderMgcpLink.updateMany({ where: { id: linkId, orderId }, data: { status } }),
  saveFile: async (orderId, file) => {
    const filename = `${randomUUID()}${extname(file.name) || ''}`;
    const dir = join(FILES_DIR, String(orderId));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), Buffer.from(await file.arrayBuffer()));
    return filename;
  },
  commitCapture: (a) =>
    prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.create({
        data: { orderId: a.orderId, merchant: a.merchant, value: a.value, cardNumber: a.cardNumber, pin: a.pin },
      });
      for (const f of a.files) {
        await tx.orderAttachment.create({
          data: { orderId: a.orderId, giftCardId: card.id, filename: f.filename, originalName: f.originalName, mimeType: f.mimeType },
        });
      }
      await tx.orderMgcpLink.update({ where: { id: a.linkId }, data: { status: 'captured', giftCardId: card.id } });
      return card.id;
    }),
  decrypt: decryptSetting,
};

export async function GET(req: Request) { return handleList(deps, req); }
export async function POST(req: Request) { return handleCapture(deps, req); }
export async function PATCH(req: Request) { return handleStatus(deps, req); }
