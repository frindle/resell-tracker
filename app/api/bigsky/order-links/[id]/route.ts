import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const id = parseInt((await params).id, 10);
  if (!Number.isFinite(id)) return Response.json({ error: 'bad id' }, { status: 400 });
  const { count } = await prisma.orderBigSkyLink.deleteMany({ where: { id, order: { userId: uid } } });
  if (count === 0) return Response.json({ error: 'link not found' }, { status: 404 });
  return Response.json({ deleted: true });
}
