import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Returns a map of normalized order number → { id, orderNumber, itemDescription }
// for orders assigned to BFMR buyers, so the BFMR tracker page can link back.
export async function GET() {
  try {
    const userId = await getSessionUserId();
    const uid = userId ?? null;

    const orders = await prisma.order.findMany({
      where: {
        ...(uid ? { userId: uid } : { userId: null }),
        orderNumber: { not: null },
        buyer: { name: { contains: 'BFMR' } },
      },
      select: { id: true, orderNumber: true, itemDescription: true, groupReferenceId: true },
    });

    const result: Record<string, { id: number; orderNumber: string | null; itemDescription: string | null }> = {};
    for (const o of orders) {
      const norm = (o.orderNumber ?? '').replace(/\D/g, '');
      if (norm) result[norm] = { id: o.id, orderNumber: o.orderNumber, itemDescription: o.itemDescription };
      const overrideNorm = (o.groupReferenceId ?? '').replace(/\D/g, '');
      if (overrideNorm) result[overrideNorm] = { id: o.id, orderNumber: o.orderNumber, itemDescription: o.itemDescription };
    }
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
