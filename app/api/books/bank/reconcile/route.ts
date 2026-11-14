import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { MONTH_RE } from '@/lib/books/dates';
import { getGoLive } from '@/lib/books/service';
import { reconcileGrid, lockGate } from '@/lib/books/bank/posting';
import { preGoLiveUndeposited } from '@/lib/books/bank/payoutOrders';

/** ?month=YYYY-MM : one row per mapped account with the statement, the books, the in-transit items, the lock gate, and the one-time pre-go-live undeposited check. */
export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const month = req.nextUrl.searchParams.get('month') ?? '';
    if (!MONTH_RE.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    const goLive = await getGoLive(userId);
    return Response.json({ month, accounts: await reconcileGrid(userId, month, goLive), gate: await lockGate(userId, month, goLive), undeposited: await preGoLiveUndeposited(userId) });
  });
}
