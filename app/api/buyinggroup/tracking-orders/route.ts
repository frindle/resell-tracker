import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

// Returns map of normalized tracking → [{id, itemDescription, salePrice, bgExpectedPayout}]
// for orders assigned to BuyingGroup or BFMR buyers
export async function GET() {
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const orders = await prisma.order.findMany({
    where: {
      ...(uid ? { userId: uid } : { userId: null }),
      buyer: { OR: [{ name: { contains: 'BuyingGroup' } }, { name: { contains: 'BFMR' } }] },
    },
    select: { id: true, orderNumber: true, itemDescription: true, salePrice: true, bgExpectedPayout: true, trackingNumbers: true, platform: true },
  });

  type Entry = { id: number; orderNumber: string | null; itemDescription: string | null; salePrice: number | null; bgExpectedPayout: number | null; platform: string };
  const result: Record<string, Entry[]> = {};
  function addEntry(key: string, entry: Entry) {
    if (!key) return;
    if (!result[key]) result[key] = [];
    if (!result[key].some(e => e.id === entry.id)) result[key].push(entry);
  }
  for (const o of orders) {
    const entry = { id: o.id, orderNumber: o.orderNumber, itemDescription: o.itemDescription, salePrice: o.salePrice, bgExpectedPayout: o.bgExpectedPayout, platform: o.platform };
    if (o.trackingNumbers) {
      for (const t of o.trackingNumbers.split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean)) {
        addEntry(t, entry);
      }
    }
    const normOrder = (o.orderNumber ?? '').replace(/\D/g, '');
    if (normOrder) addEntry(normOrder, entry);
  }
  return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
