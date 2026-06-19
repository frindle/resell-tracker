import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  try {
  const addresses = await prisma.blockedAddress.findMany({ orderBy: { createdAt: 'asc' } });
  return Response.json(addresses);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const body = await req.json();
  const address = await prisma.blockedAddress.create({
    data: { label: body.label, pattern: body.pattern },
  });
  return Response.json(address, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
