import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
  const { userId } = await req.json();
  if (!userId) return Response.json({ error: 'Missing userId' }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  const res = Response.json({ id: user.id, name: user.name });
  res.headers.set('Set-Cookie', `resell_uid=${user.id}; HttpOnly; Path=/; SameSite=Lax`);
  return res;
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
