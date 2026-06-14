import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

type RateEntry = { portal: string; rate: string; category?: string };
type BulkPayload = { merchant: string; rates: RateEntry[] }[];

export async function POST(req: NextRequest) {
  const body = await req.json() as BulkPayload;
  if (!Array.isArray(body)) return new Response('expected array', { status: 400 });

  let upserted = 0;
  for (const { merchant, rates } of body) {
    if (!merchant?.trim() || !Array.isArray(rates)) continue;
    for (const { portal, rate, category } of rates) {
      if (!portal?.trim() || !rate?.trim()) continue;
      const m = merchant.trim();
      const p = portal.trim();
      const c = category?.trim() || null;
      const r = rate.trim();
      const existing = await prisma.portalRate.findFirst({ where: { merchant: m, portal: p, category: c } });
      if (existing) {
        await prisma.portalRate.update({ where: { id: existing.id }, data: { rate: r } });
      } else {
        await prisma.portalRate.create({ data: { merchant: m, portal: p, rate: r, category: c } });
      }
      upserted++;
    }
  }

  return Response.json({ upserted });
}
