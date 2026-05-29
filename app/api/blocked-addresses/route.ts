import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const addresses = await prisma.blockedAddress.findMany({ orderBy: { createdAt: 'asc' } });
  return Response.json(addresses);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const address = await prisma.blockedAddress.create({
    data: { label: body.label, pattern: body.pattern },
  });
  return Response.json(address, { status: 201 });
}
