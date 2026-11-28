import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { parseCarrierPage } from '@/lib/carrierPage';
import { carrierKey } from '@/lib/carrierQueue';
import { recordExpectedForTracking } from '@/lib/expectedDeliveryDb';

export const dynamic = 'force-dynamic';

const MAX_TEXT = 200_000;

// The extension posts the visible text of a FedEx / UPS tracking page it opened. Neither the text nor the
// tracking number is logged.
export async function POST(req: NextRequest) {
  try {
    const userId = resolveExtensionUserId(req, await getSessionUserId());
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => null) as { carrier?: unknown; trackingNumber?: unknown; url?: unknown; text?: unknown } | null;
    const carrier = body?.carrier;
    if (carrier !== 'fedex' && carrier !== 'ups') return Response.json({ error: 'carrier must be fedex|ups' }, { status: 400 });
    const trackingNumber = typeof body?.trackingNumber === 'string' ? carrierKey(body.trackingNumber) : '';
    if (!trackingNumber || trackingNumber.length > 40) return Response.json({ error: 'trackingNumber required' }, { status: 400 });
    if (typeof body?.text !== 'string' || !body.text) return Response.json({ error: 'text required' }, { status: 400 });
    if (body.text.length > MAX_TEXT) return Response.json({ error: 'page too large' }, { status: 413 });

    const now = new Date();
    const result = parseCarrierPage(body.text, now);
    const existing = await prisma.carrierDelivery.findUnique({ where: { userId_trackingNumber: { userId, trackingNumber } } });
    // A delivery already recorded is not undone by a later page that reads differently.
    if (existing?.status === 'delivered' && existing.deliveredAt) {
      return Response.json({ ok: true, status: 'delivered' });
    }
    const data = {
      carrier,
      status: result.status,
      deliveredAt: result.status === 'delivered' ? result.deliveredAt ?? null : null,
      source: 'carrier-page',
      checkedAt: now,
    };
    await prisma.carrierDelivery.upsert({
      where: { userId_trackingNumber: { userId, trackingNumber } },
      create: { userId, trackingNumber, attempts: 1, ...data },
      update: data,
    });
    // "Estimated delivery ..." on a package that is not delivered: the carrier's own expected day for its orders.
    if (result.status !== 'delivered') await recordExpectedForTracking(userId, trackingNumber, body.text, now);
    return Response.json({ ok: true, status: result.status });
  } catch (e) {
    console.error('[carrier-page] failed:', String(e).slice(0, 200));
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
