import { withBooks } from '@/lib/books/api';
import { syncSimpleFin } from '@/lib/books/bank/service';
import { SimpleFinError } from '@/lib/books/bank/simplefin';

export async function POST() {
  return withBooks(async userId => {
    try {
      return Response.json({ ok: true, ...(await syncSimpleFin(userId, { manual: true })) });
    } catch (e) {
      const status = e instanceof SimpleFinError && e.status ? 502 : 400;
      return Response.json({ error: e instanceof Error ? e.message : 'sync failed' }, { status });
    }
  });
}
