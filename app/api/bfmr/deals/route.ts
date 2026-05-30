import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getDeals } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

async function getCreds(uid: number | null) {
  const [k, s] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!k?.value || !s?.value) return null;
  return { apiKey: k.value, apiSecret: s.value };
}

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  const creds = await getCreds(userId ?? null);
  if (!creds) return new Response('BFMR not configured', { status: 400 });

  const sp = req.nextUrl.searchParams;
  try {
    const deals = await getDeals(creds, {
      page_size: sp.has('page_size') ? Number(sp.get('page_size')) : 50,
      page_no: sp.has('page_no') ? Number(sp.get('page_no')) : undefined,
      retailer: sp.get('retailer') ?? undefined,
      retail_type: sp.get('retail_type') ?? undefined,
      in_stock: (sp.get('in_stock') as '0' | '1') ?? undefined,
      exclusive_deals_only: (sp.get('exclusive_deals_only') as '0' | '1') ?? undefined,
    });
    return Response.json(deals);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
