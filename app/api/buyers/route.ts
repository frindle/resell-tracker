import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const buyers = await prisma.buyer.findMany({ orderBy: { name: 'asc' } });
  return Response.json(buyers);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const buyer = await prisma.buyer.create({ data: { name: body.name } });
  return Response.json(buyer, { status: 201 });
}
