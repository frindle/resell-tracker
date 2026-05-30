import { prisma } from '@/lib/db';

export async function GET() {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json(users);
}
