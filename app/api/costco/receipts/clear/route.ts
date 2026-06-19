import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';
import { unlink } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';

export async function POST(req: NextRequest) {
  try {
  const body = await req.json().catch(() => ({})) as { all?: boolean };

  if (body.all) {
    // Unlink all receipts: delete their costco-receipt attachments and clear orderId
    const linked = await prisma.costcoReceipt.findMany({
      where: { orderId: { not: null } },
      select: { id: true, transactionBarcode: true, orderId: true },
    });
    for (const r of linked) {
      if (!r.orderId) continue;
      for (const ext of ['pdf', 'html', 'json']) {
        const filename = `costco-receipt-${r.transactionBarcode}.${ext}`;
        const att = await prisma.orderAttachment.findFirst({ where: { orderId: r.orderId, filename } });
        if (att) {
          await prisma.orderAttachment.delete({ where: { id: att.id } });
          await unlink(join(FILES_DIR, String(r.orderId), filename)).catch(() => {});
        }
      }
      await prisma.costcoReceipt.update({ where: { id: r.id }, data: { orderId: null } });
    }
    // Also delete unlinked ones
    const { count } = await prisma.costcoReceipt.deleteMany({ where: { orderId: null } });
    return Response.json({ unlinked: linked.length, deleted: count });
  }

  // Default: delete only unlinked receipts
  const { count } = await prisma.costcoReceipt.deleteMany({ where: { orderId: null } });
  return Response.json({ deleted: count });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
