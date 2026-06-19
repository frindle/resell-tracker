import { prisma } from '@/lib/db';

export async function GET() {
  try {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json(users);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
