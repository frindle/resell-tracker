import { prisma } from '@/lib/db';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getDeals, type BGDeal } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

async function saveSnapshots(deals: BGDeal[]) {
  if (deals.length === 0) return;
  const dealIds = deals.map(d => String(d.deal_id ?? d.key));

  // One query for the latest snapshot per deal
  const latest = await prisma.bgDealSnapshot.findMany({
    where: { dealId: { in: dealIds } },
    orderBy: { snapshotAt: 'desc' },
    distinct: ['dealId'],
    select: { dealId: true, payoutPrice: true },
  });
  const latestMap = new Map(latest.map(s => [s.dealId, s.payoutPrice]));

  const toInsert = deals.flatMap(d => {
    const payoutPrice = parseFloat(String(d.commission ?? 0));
    if (!payoutPrice) return [];
    const prev = latestMap.get(String(d.deal_id ?? d.key));
    if (prev === payoutPrice) return [];
    return [{
      dealId: String(d.deal_id ?? d.key),
      title: d.title ?? '',
      storeName: '',
      retailPrice: parseFloat(String(d.price ?? 0)),
      payoutPrice,
    }];
  });

  if (toInsert.length > 0) {
    await prisma.bgDealSnapshot.createMany({ data: toInsert });
  }
}

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!await isBgConfigured(userId ?? null)) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '60');
  const dataType = (searchParams.get('data_type') ?? 'on_sale_now') as 'on_sale_now' | 'below_cost' | 'all';
  const title = searchParams.get('title') ?? '';

  try {
    const token = await getBgAccessToken(userId ?? null);
    const data = await getDeals(token, { page, pageSize, dataType, title });
    const deals: BGDeal[] = Array.isArray(data) ? data : ((data as { results?: BGDeal[] }).results ?? []);

    // Save payout snapshots in the background — don't block the response
    saveSnapshots(deals).catch(() => {});

    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
