import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

// Returns Amazon + Walmart orders missing shippingAddress or itemDescription.
// Auth: prefers session, falls back to X-Extension-User-Id header so the
// extension's "Backfill missing data" button can hit this endpoint without
// a browser session cookie. Without this fallback the query found 0 orders
// because resolvedUserId was always null when called from the extension.
export async function GET(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const headerUid = req.headers.get('X-Extension-User-Id');
    const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);

    const orders = await prisma.order.findMany({
      where: {
        userId: userId,
        platform: { in: ['Amazon', 'Walmart'] },
        orderNumber: { not: null },
        OR: [
          { shippingAddress: null },
          { shippingAddress: '' },
          { itemDescription: null },
          { itemDescription: '' },
        ],
      },
      select: { id: true, platform: true, orderNumber: true, sourceUrl: true, shippingAddress: true, itemDescription: true },
    });

    return Response.json(orders, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Extension-User-Id',
    },
  });
}
