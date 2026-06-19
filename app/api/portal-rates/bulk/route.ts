import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

type RateEntry = { portal: string; rate: string; category?: string };
type BulkPayload = { merchant: string; rates: RateEntry[] }[];

export async function POST(req: NextRequest) {
  try {
  const body = await req.json() as BulkPayload;
  if (!Array.isArray(body)) return new Response('expected array', { status: 400 });

  let upserted = 0;
  for (const { merchant, rates } of body) {
    if (!merchant?.trim() || !Array.isArray(rates)) continue;
    for (const { portal, rate, category } of rates) {
      if (!portal?.trim() || !rate?.trim()) continue;
      const m = merchant.trim();
      const p = portal.trim();
      const c = category?.trim() || '';
      const r = rate.trim();
      await prisma.portalRate.upsert({
        where: { merchant_portal_category: { merchant: m, portal: p, category: c } },
        update: { rate: r },
        create: { merchant: m, portal: p, rate: r, category: c },
      });
      upserted++;
    }
  }

  return Response.json({ upserted });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
