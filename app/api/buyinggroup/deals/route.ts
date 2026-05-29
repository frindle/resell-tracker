import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getDeals } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  if (!await isBgConfigured()) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '60');
  const dataType = (searchParams.get('data_type') ?? 'on_sale_now') as 'on_sale_now' | 'below_cost' | 'all';
  const title = searchParams.get('title') ?? '';

  try {
    const token = await getBgAccessToken();
    const data = await getDeals(token, { page, pageSize, dataType, title });
    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
