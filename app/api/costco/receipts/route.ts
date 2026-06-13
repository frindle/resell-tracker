import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { generateReceiptPdf, type ReceiptData } from '@/lib/costcoReceipt';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const FILES_DIR = '/data/files';

async function linkReceiptToOrder(receipt: { id: number; transactionBarcode: string; receiptData: string }, orderId: number) {
  const data = JSON.parse(receipt.receiptData) as ReceiptData;
  const pdf = await generateReceiptPdf(data);
  const filename = `costco-receipt-${receipt.transactionBarcode}.pdf`;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  await writeFile(join(orderDir, filename), pdf);

  const existingAtt = await prisma.orderAttachment.findFirst({ where: { orderId, filename } });
  await prisma.costcoReceipt.update({ where: { id: receipt.id }, data: { orderId } });
  if (!existingAtt) {
    await prisma.orderAttachment.create({
      data: {
        orderId,
        filename,
        originalName: `Costco Receipt ${data.transactionDate ?? receipt.transactionBarcode}.pdf`,
        mimeType: 'application/pdf',
      },
    });
  }
}

// POST /api/costco/receipts — import receipts from extension
export async function POST(req: NextRequest) {
  const headerUserId = req.headers.get('X-Extension-User-Id');
  const userId = headerUserId ? parseInt(headerUserId) : await getSessionUserId();
  const receipts = await req.json() as ReceiptData[];
  if (!Array.isArray(receipts)) return new Response('Expected array', { status: 400 });

  let linked = 0;
  let unlinked = 0;
  let skipped = 0;

  for (const receipt of receipts) {
    const existing = await prisma.costcoReceipt.findUnique({ where: { transactionBarcode: receipt.transactionBarcode } });
    if (existing?.orderId) { skipped++; continue; }

    const upserted = await prisma.costcoReceipt.upsert({
      where: { transactionBarcode: receipt.transactionBarcode },
      update: { receiptData: JSON.stringify(receipt), warehouseName: receipt.warehouseName, total: receipt.total },
      create: {
        transactionBarcode: receipt.transactionBarcode,
        transactionDate: receipt.transactionDate ?? receipt.transactionDateTime?.split('T')[0] ?? '',
        warehouseName: receipt.warehouseName,
        total: receipt.total,
        receiptData: JSON.stringify(receipt),
      },
    });

    // Try to auto-link: exact order number match first, then fall back to date
    const exactMatch = await prisma.order.findFirst({
      where: {
        ...(userId ? { userId } : { userId: null }),
        orderNumber: upserted.transactionBarcode,
      },
      select: { id: true },
    });

    if (exactMatch) {
      try {
        await linkReceiptToOrder(upserted, exactMatch.id);
        linked++;
        continue;
      } catch (e) {
        console.error('[receipts] auto-link failed', e);
      }
    }

    const date = upserted.transactionDate;
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const dateMatches = await prisma.order.findMany({
      where: {
        ...(userId ? { userId } : { userId: null }),
        orderDate: { gte: startOfDay, lte: endOfDay },
      },
      select: { id: true },
    });

    if (dateMatches.length === 1) {
      try {
        await linkReceiptToOrder(upserted, dateMatches[0].id);
        linked++;
      } catch (e) {
        console.error('[receipts] auto-link failed', e);
        unlinked++;
      }
    } else {
      unlinked++;
    }
  }

  return Response.json({ linked, unlinked, skipped });
}

// GET /api/costco/receipts — list unlinked receipts
export async function GET() {
  const userId = await getSessionUserId();
  const receipts = await prisma.costcoReceipt.findMany({
    where: { orderId: null },
    orderBy: { transactionDate: 'desc' },
    select: { id: true, transactionBarcode: true, transactionDate: true, warehouseName: true, total: true },
  });

  // For each unlinked receipt, find candidate orders by date
  const withCandidates = await Promise.all(receipts.map(async r => {
    const startOfDay = new Date(`${r.transactionDate}T00:00:00.000Z`);
    const endOfDay = new Date(`${r.transactionDate}T23:59:59.999Z`);
    const candidates = await prisma.order.findMany({
      where: {
        ...(userId ? { userId } : { userId: null }),
        OR: [
          { orderNumber: r.transactionBarcode },
          { orderDate: { gte: startOfDay, lte: endOfDay } },
        ],
      },
      select: { id: true, platform: true, orderNumber: true, itemDescription: true },
    });
    return { ...r, candidates };
  }));

  return Response.json(withCandidates);
}
