import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const rules = await prisma.senderRule.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json(rules);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { label, pattern } = await req.json();
  if (!pattern?.trim()) return Response.json({ error: 'Pattern required' }, { status: 400 });

  const rule = await prisma.senderRule.create({
    data: { userId, label: label?.trim() || pattern.trim(), pattern: pattern.trim() },
  });
  return Response.json(rule, { status: 201 });
}
