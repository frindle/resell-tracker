import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import type { ReceiptData } from '@/lib/costcoReceipt';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';

// Costco warehouse (in-store) tenders that are a gift/shop/cash card rather
// than a real payment method. Matched case-insensitively against
// tenderArray[].tenderDescription. These are the receipts Task D targets:
// in-warehouse purchases paid with (or partly with) a Costco Shop Card /
// Cash Card, which otherwise never become orders because they have no
// online getOnlineOrders record to import from.
const GIFT_CARD_TENDER_RE = /shop\s*card|cash\s*card|gift\s*card|merchandise\s*card|costco\s*cash/i;

function receiptHasGiftCardTender(receipt: ReceiptData): boolean {
  return (receipt.tenderArray ?? []).some(t =>
    typeof t.tenderDescription === 'string' && GIFT_CARD_TENDER_RE.test(t.tenderDescription),
  );
}

function receiptItemDescription(receipt: ReceiptData): string {
  const names = (receipt.itemArray ?? [])
    .map(i => (i.itemDescription01 ?? '').trim())
    .filter(Boolean);
  return [...new Set(names)].join(', ').slice(0, 200);
}

async function linkReceiptToOrder(
  receipt: { id: number; transactionBarcode: string; receiptData: string },
  orderId: number,
) {
  const data = JSON.parse(receipt.receiptData) as ReceiptData;
  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });

  const filename = `costco-receipt-${receipt.transactionBarcode}.json`;
  const originalName = `Costco Receipt ${data.transactionDate ?? receipt.transactionBarcode}.json`;
  const mimeType = 'application/json';

  await writeFile(join(orderDir, filename), receipt.receiptData);

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
  const sessionUid = await getSessionUserId();
  const userId = resolveExtensionUserId(req, sessionUid);
  const body = await req.json() as { receipts?: ReceiptData[] } | ReceiptData[];

  // Accept both old (bare array) and new ({ receipts }) shapes
  let receipts: ReceiptData[];
  if (Array.isArray(body)) {
    receipts = body;
  } else {
    receipts = body.receipts ?? [];
  }

  if (!Array.isArray(receipts)) return new Response('Expected receipts array', { status: 400 });

  let linked = 0;
  let unlinked = 0;
  let skipped = 0;
  let imported = 0; // in-warehouse gift-card receipts auto-created as orders

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
      select: { id: true, orderNumber: true, userId: true },
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
        continue;
      } catch (e) {
        console.error('[receipts] auto-link failed', e);
        unlinked++;
        continue;
      }
    }

    // Task D: an in-warehouse receipt with no matching online order. If it
    // was paid with (or partly with) a Costco gift/shop card, auto-import it
    // as its own in-warehouse order and link the receipt to it — otherwise
    // this purchase would never surface as an order at all. tenderArray is
    // the only signal that distinguishes these; it's present on warehouse
    // receipt details (see lib/costcoReceipt.ReceiptData).
    if (receiptHasGiftCardTender(receipt)) {
      try {
        const orderDate = new Date(receipt.transactionDateTime ?? `${date}T12:00:00.000Z`);
        const created = await prisma.order.create({
          data: {
            ...(userId ? { userId } : {}),
            platform: 'Costco',
            orderNumber: upserted.transactionBarcode,
            orderDate: isNaN(orderDate.getTime()) ? new Date() : orderDate,
            itemDescription: receiptItemDescription(receipt) || 'Costco in-warehouse purchase',
            cost: receipt.total ?? 0,
            notes: `In-warehouse Costco purchase (gift-card tender). Warehouse: ${receipt.warehouseName ?? 'unknown'}.`,
          },
          select: { id: true },
        });
        await linkReceiptToOrder(upserted, created.id);
        imported++;
        continue;
      } catch (e) {
        console.error('[receipts] gift-card auto-import failed', e);
        unlinked++;
        continue;
      }
    }

    unlinked++;
  }

  return Response.json({ linked, unlinked, skipped, imported });
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
