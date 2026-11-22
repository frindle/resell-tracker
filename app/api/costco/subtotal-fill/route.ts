import { getSessionUserId } from '@/lib/auth';
import { queueCostcoSubtotalFill } from '@/lib/costcoSubtotalFill';

export const dynamic = 'force-dynamic';

// Settings > Costco Executive Reward: read the merchandise subtotal from
// Costco for every Costco order still without one, locked orders included.
export async function POST() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  try {
    return Response.json(await queueCostcoSubtotalFill(uid));
  } catch (e) {
    console.error('[costco-subtotal] queue failed:', String(e).slice(0, 160));
    return Response.json({ error: 'could not queue' }, { status: 500 });
  }
}
