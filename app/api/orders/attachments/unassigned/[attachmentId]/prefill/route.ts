import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { prefillFromPhoto } from '@/lib/photoPrefill';

// New Order form values guessed from what OCR read off an unsorted photo
// (lib/photoPrefill.ts). Used when creating an order from a photo that
// matched nothing.

const DEFAULT_PLATFORMS = ['Amazon', 'Walmart', 'Costco', 'Best Buy', 'Target'];
const DEFAULT_BRANDS = ['Amazon', 'Apple', 'Best Buy', 'Target', 'Walmart', 'Home Depot', 'Lowe\'s', 'Visa', 'Mastercard', 'Uber', 'DoorDash', 'Starbucks', 'Nike', 'Sephora', 'Airbnb', 'Southwest'];

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const uid = resolveExtensionUserId(req, await getSessionUserId());
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const att = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId: null, userId: uid },
    include: { photoOcr: true },
  });
  if (!att) return Response.json({ error: 'not found' }, { status: 404 });
  const ocr = att.photoOcr;
  if (!ocr || ocr.status !== 'done') return Response.json({ status: ocr?.status ?? 'unread', prefill: {} });

  const [platformRows, merchantRows, cards] = await Promise.all([
    prisma.order.findMany({ where: { userId: uid }, select: { platform: true }, distinct: ['platform'] }),
    prisma.giftCard.findMany({ where: { order: { userId: uid } }, select: { merchant: true }, distinct: ['merchant'] }),
    prisma.creditCard.findMany({ where: { userId: uid }, select: { id: true, last4: true, lastFours: { select: { last4: true } } } }),
  ]);
  const prefill = prefillFromPhoto(
    {
      kind: ocr.kind, texts: parseJson<string[]>(ocr.texts, []), candidates: parseJson<string[]>(ocr.candidates, []),
      capturedAt: ocr.capturedAt ?? att.createdAt,
    },
    {
      platforms: [...new Set([...DEFAULT_PLATFORMS, ...platformRows.map(r => r.platform)])],
      merchants: [...new Set([...DEFAULT_BRANDS, ...merchantRows.map(r => r.merchant)])],
      cards: cards.map(c => ({ id: c.id, last4s: [c.last4, ...c.lastFours.map(l => l.last4)].filter((x): x is string => !!x) })),
    },
  );
  return Response.json({ status: 'done', kind: ocr.kind, prefill });
}
