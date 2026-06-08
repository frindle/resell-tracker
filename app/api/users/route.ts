import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: { select: { orders: true, senderRules: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Response.json(users, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[GET /api/users]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name } = await req.json();
    if (!name?.trim()) {
      return Response.json({ error: 'Name required' }, { status: 400 });
    }
    const user = await prisma.user.create({
      data: { name: name.trim() },
      select: { id: true, name: true, createdAt: true },
    });
    return Response.json(user, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/users]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Claim all unclaimed (userId = null) orders/cards/etc for current user
export async function PUT() {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const [orders, cards, shippingRules, settings] = await Promise.all([
    prisma.order.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.creditCard.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.shippingRule.updateMany({ where: { userId: null }, data: { userId } }),
    prisma.setting.updateMany({ where: { userId: null }, data: { userId } }),
  ]);

  return Response.json({ orders: orders.count, cards: cards.count, shippingRules: shippingRules.count, settings: settings.count });
}
