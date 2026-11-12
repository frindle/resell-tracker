import { withBooks } from '@/lib/books/api';
import { PrismaStore } from '@/lib/books/prismaStore';
import { getGoLive, loadOrders } from '@/lib/books/service';
import { parityCheck, periodView } from '@/lib/books/parity';

export async function GET() {
  return withBooks(async userId => {
    const goLive = await getGoLive(userId);
    const [orders, lines] = await Promise.all([loadOrders(userId), new PrismaStore().ledgerLines(userId)]);
    const rows = parityCheck(orders, lines, goLive, new Date());
    return Response.json({
      goLive,
      counts: {
        match: rows.filter(r => r.status === 'match').length,
        mismatch: rows.filter(r => r.status === 'mismatch').length,
        timing: rows.filter(r => r.status === 'timing').length,
      },
      rows,
      period: periodView(orders, lines, goLive),
    });
  });
}
