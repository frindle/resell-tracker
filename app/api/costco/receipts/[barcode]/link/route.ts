import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { generateReceiptPdf, type ReceiptData } from '@/lib/costcoReceipt';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';

// POST /api/costco/receipts/[barcode]/link — link an unlinked receipt to an order
export async function POST(req: NextRequest, { params }: { params: Promise<{ barcode: string }> }) {
  const userId = await getSessionUserId();
  const { barcode } = await params;
  const { orderId } = await req.json() as { orderId: number };

  const receipt = await prisma.costcoReceipt.findUnique({ where: { transactionBarcode: barcode } });
  if (!receipt) return new Response('Not found', { status: 404 });

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Order not found', { status: 404 });

  const data = JSON.parse(receipt.receiptData) as ReceiptData;
  const pdf = await generateReceiptPdf(data);
  const filename = `costco-receipt-${barcode}.pdf`;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  await writeFile(join(orderDir, filename), pdf);

  const existingAtt = await prisma.orderAttachment.findFirst({ where: { orderId, filename } });
  await prisma.costcoReceipt.update({ where: { transactionBarcode: barcode }, data: { orderId } });
  if (!existingAtt) {
    await prisma.orderAttachment.create({
      data: {
        orderId,
        filename,
        originalName: `Costco Receipt ${data.transactionDate ?? barcode}.pdf`,
        mimeType: 'application/pdf',
      },
    });
  }

  return Response.json({ ok: true });
}

// DELETE /api/costco/receipts/[barcode]/link — unlink
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ barcode: string }> }) {
  const { barcode } = await params;
  const receipt = await prisma.costcoReceipt.findUnique({ where: { transactionBarcode: barcode } });
  if (!receipt) return new Response('Not found', { status: 404 });

  if (receipt.orderId) {
    const filename = `costco-receipt-${barcode}.pdf`;
    await prisma.orderAttachment.deleteMany({ where: { orderId: receipt.orderId, filename } });
  }
  await prisma.costcoReceipt.update({ where: { transactionBarcode: barcode }, data: { orderId: null } });
  return Response.json({ ok: true });
}
