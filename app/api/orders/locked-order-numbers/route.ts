import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';

export const dynamic = 'force-dynamic';

// Returns the set of order numbers already locked for the current user.
// The extension uses this to skip re-scraping orders whose data won't
// be applied server-side anyway (locked orders reject writes). Skipping
// on the client also avoids the per-order detail fetch, which is where
// the Amazon rescrape cost lives — one fewer HTTP round-trip per locked
// order per sync.
export async function GET(req: Request) {
  // Same X-Extension-User-Id fallback /api/import uses — lets unattended
  // callers with no session cookie (the browser extension, and now the
  // headless sidecar) skip re-scraping locked orders too.
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const url = new URL(req.url);
  const rawPlatform = url.searchParams.get('platform');
  const platform = rawPlatform ? rawPlatform.charAt(0).toUpperCase() + rawPlatform.slice(1).toLowerCase() : null;

  const orders = await prisma.order.findMany({
    where: {
      userId: uid,
      locked: true,
      ...(platform ? { platform } : {}),
      orderNumber: { not: null },
    },
    select: { orderNumber: true },
  });

  const numbers = Array.from(new Set(orders.map(o => o.orderNumber).filter((n): n is string => !!n)));
  return Response.json({ orderNumbers: numbers, count: numbers.length });
}
