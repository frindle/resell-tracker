import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getSetting } from '@/lib/db';
import { getBgAccessToken } from '@/lib/bgAuth';
import { submitTracking as bgSubmitTracking } from '@/lib/buyinggroup';
import { submitTracking as bsSubmitTracking } from '@/lib/bigsky';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const { ids } = await req.json() as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return Response.json({ error: 'No order IDs provided' }, { status: 400 });
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: ids }, ...(uid ? { userId: uid } : { userId: null }) },
    include: { buyer: true },
  });

  // Separate by buyer group, keeping a per-group order-id list so we can
  // mark trackingSubmittedToBg after a successful submit.
  const bgTrackings: string[] = [];
  const bgOrderIds: number[] = [];
  const bsTrackings: string[] = [];
  const bsOrderIds: number[] = [];

  for (const order of orders) {
    if (!order.trackingNumbers) continue;
    const trackings = order.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
    const buyerName = order.buyer?.name?.toLowerCase() ?? '';
    if (buyerName.includes('buyinggroup') || buyerName.includes('buying group')) {
      bgTrackings.push(...trackings);
      bgOrderIds.push(order.id);
    } else if (buyerName.includes('bigsky') || buyerName.includes('big sky')) {
      bsTrackings.push(...trackings);
      bsOrderIds.push(order.id);
    }
  }

  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const submittedIds: number[] = [];

  if (bgTrackings.length > 0) {
    try {
      const token = await getBgAccessToken(uid);
      results.buyinggroup = await bgSubmitTracking(token, bgTrackings);
      results.buyinggroup_count = bgTrackings.length;
      submittedIds.push(...bgOrderIds);
    } catch (e) {
      errors.buyinggroup = String(e);
    }
  }

  if (bsTrackings.length > 0) {
    try {
      const cookieSetting = await getSetting(uid, 'bigsky_cookie');
      if (!cookieSetting?.value) throw new Error('BigSky cookie not configured');
      results.bigsky = await bsSubmitTracking(cookieSetting.value, bsTrackings);
      results.bigsky_count = bsTrackings.length;
      submittedIds.push(...bsOrderIds);
    } catch (e) {
      errors.bigsky = String(e);
    }
  }

  if (submittedIds.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: submittedIds } },
      data: { trackingSubmittedToBg: true },
    });
  }

  const submitted = bgTrackings.length + bsTrackings.length;
  if (submitted === 0) {
    return Response.json({ error: 'No tracking numbers found on selected orders for BuyingGroup or BigSky buyers' }, { status: 400 });
  }

  return Response.json({ submitted, results, errors: Object.keys(errors).length ? errors : undefined });
}
