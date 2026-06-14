import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  const rates = await prisma.portalRate.findMany({ orderBy: [{ merchant: 'asc' }, { portal: 'asc' }] });
  return Response.json(rates);
}

export async function POST(req: NextRequest) {
  const { merchant, category, portal, rate } = await req.json() as {
    merchant: string; category?: string; portal: string; rate: string;
  };
  if (!merchant?.trim() || !portal?.trim() || !rate?.trim()) {
    return new Response('merchant, portal, and rate are required', { status: 400 });
  }
  const row = await prisma.portalRate.create({
    data: { merchant: merchant.trim(), category: category?.trim() || null, portal: portal.trim(), rate: rate.trim() },
  });
  return Response.json(row, { status: 201 });
}
