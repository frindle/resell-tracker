import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ count: 0 });
    const count = await prisma.apiError.count({
      where: { userId, seen: false },
    });
    return Response.json({ count });
  } catch (e) {
    return Response.json({ count: 0, error: String(e) });
  }
}

// Mark all unseen errors as seen (called when user opens /api-errors)
export async function POST() {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
    await prisma.apiError.updateMany({ where: { userId, seen: false }, data: { seen: true } });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
