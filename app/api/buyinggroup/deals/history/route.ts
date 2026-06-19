import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  try {
  const dealId = req.nextUrl.searchParams.get('dealId');
  if (!dealId) return Response.json([]);

  const snapshots = await prisma.bgDealSnapshot.findMany({
    where: { dealId },
    orderBy: { snapshotAt: 'asc' },
    select: { payoutPrice: true, retailPrice: true, snapshotAt: true },
  });

  return Response.json(snapshots);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
