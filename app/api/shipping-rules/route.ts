import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET() {
  const rules = await prisma.shippingRule.findMany({
    include: { buyer: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json(rules);
}

export async function POST(req: NextRequest) {
  const { label, pattern, buyerId } = await req.json();
  if (!label || !pattern) return new Response('label and pattern required', { status: 400 });
  const rule = await prisma.shippingRule.create({
    data: { label, pattern, buyerId: buyerId ? parseInt(buyerId) : null },
    include: { buyer: { select: { id: true, name: true } } },
  });
  return Response.json(rule, { status: 201 });
}
