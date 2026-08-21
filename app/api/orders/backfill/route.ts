import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';

// See app/api/settings/route.ts for why -- same class of bug, and this
// route is scoped per-user (session/X-Extension-User-Id), so a cached
// response would leak one user's orders to every caller.
export const dynamic = 'force-dynamic';

// Returns Amazon + Walmart orders missing shippingAddress or itemDescription.
// Auth: prefers session, falls back to X-Extension-User-Id header so the
// extension's "Backfill missing data" button can hit this endpoint without
// a browser session cookie. Without this fallback the query found 0 orders
// because resolvedUserId was always null when called from the extension.
export async function GET(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const userId = resolveExtensionUserId(req, sessionUid);

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
      'Access-Control-Allow-Headers': 'Content-Type, X-Extension-User-Id, X-Extension-Secret',
    },
  });
}
