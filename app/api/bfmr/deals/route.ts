import { prisma } from '@/lib/db';
import { getDeals } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

async function getCreds() {
  const [k, s] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bfmr_api_key' } }),
    prisma.setting.findUnique({ where: { key: 'bfmr_api_secret' } }),
  ]);
  if (!k?.value || !s?.value) return null;
  return { apiKey: k.value, apiSecret: s.value };
}

export async function GET(req: NextRequest) {
  const creds = await getCreds();
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
