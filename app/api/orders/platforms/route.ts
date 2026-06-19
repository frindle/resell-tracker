import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

const DEFAULT_PLATFORMS = ['Amazon', 'Walmart', 'Costco'];

export async function GET() {
  try {
  const userId = await getSessionUserId();
  const rows = await prisma.order.findMany({
    where: userId ? { userId } : { userId: null },
    select: { platform: true },
    distinct: ['platform'],
  });
  const custom = rows.map(r => r.platform).filter(p => p && !DEFAULT_PLATFORMS.includes(p));
  return Response.json(custom);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
