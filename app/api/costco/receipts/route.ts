import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import type { ReceiptData } from '@/lib/costcoReceipt';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';

async function linkReceiptToOrder(
  receipt: { id: number; transactionBarcode: string; receiptData: string },
  orderId: number,
  receiptHtml?: string,
) {
  const data = JSON.parse(receipt.receiptData) as ReceiptData;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });

  let filename: string;
  let originalName: string;
  let mimeType: string;
  let content: Buffer | string;

  if (receiptHtml) {
    filename = `costco-receipt-${receipt.transactionBarcode}.html`;
    originalName = `Costco Receipt ${data.transactionDate ?? receipt.transactionBarcode}.html`;
    mimeType = 'text/html';
    // Wrap the captured modal HTML in a minimal page so it renders standalone
    content = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Costco Receipt ${receipt.transactionBarcode}</title><style>html,body{margin:0;padding:16px;background:#fff;font-family:sans-serif;opacity:1!important;}.MuiDialog-paper{position:static!important;max-height:none!important;overflow:visible!important;margin:0!important;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.2);}</style></head><body>${receiptHtml}</body></html>`;
  } else {
    // Fallback: save raw receipt JSON if no HTML was captured
    filename = `costco-receipt-${receipt.transactionBarcode}.json`;
    originalName = `Costco Receipt ${data.transactionDate ?? receipt.transactionBarcode}.json`;
    mimeType = 'application/json';
    content = receipt.receiptData;
  }

  await writeFile(join(orderDir, filename), content);

  const existingAtt = await prisma.orderAttachment.findFirst({ where: { orderId, filename } });
  await prisma.costcoReceipt.update({ where: { id: receipt.id }, data: { orderId } });
  if (!existingAtt) {
    await prisma.orderAttachment.create({
      data: { orderId, filename, originalName, mimeType },
    });
  }
}

// POST /api/costco/receipts — import receipts from extension
export async function POST(req: NextRequest) {
  const headerUserId = req.headers.get('X-Extension-User-Id');
  const userId = headerUserId ? parseInt(headerUserId) : await getSessionUserId();
  const body = await req.json() as { receipts?: ReceiptData[]; receiptHtml?: Record<string, string> } | ReceiptData[];

  // Accept both old (bare array) and new ({ receipts, receiptHtml }) shapes
  let receipts: ReceiptData[];
  let receiptHtml: Record<string, string> = {};
  if (Array.isArray(body)) {
    receipts = body;
  } else {
    receipts = body.receipts ?? [];
    receiptHtml = body.receiptHtml ?? {};
  }

  if (!Array.isArray(receipts)) return new Response('Expected receipts array', { status: 400 });

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

    const html = receiptHtml[upserted.transactionBarcode];

    // Try to auto-link: exact order number match first, then fall back to date
    console.log('[receipts] linking barcode', upserted.transactionBarcode, 'userId', userId, 'hasHtml', !!html);
    const exactMatch = await prisma.order.findFirst({
      where: {
        ...(userId ? { userId } : { userId: null }),
        orderNumber: upserted.transactionBarcode,
      },
      select: { id: true, orderNumber: true, userId: true },
    });
    console.log('[receipts] exactMatch', JSON.stringify(exactMatch));

    if (exactMatch) {
      try {
        await linkReceiptToOrder(upserted, exactMatch.id, html);
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
        await linkReceiptToOrder(upserted, dateMatches[0].id, html);
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
