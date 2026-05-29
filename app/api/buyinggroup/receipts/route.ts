import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getReceipts } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  if (!await isBgConfigured()) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '50');

  try {
    const token = await getBgAccessToken();
    const data = await getReceipts(token, page, pageSize);
    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
