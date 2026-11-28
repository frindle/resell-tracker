import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { ignoreMany, HttpError } from '@/lib/books/bank/service';

/** Body { txnIds: number[] } (at most 500). Ignores the open ones; refused when any is on an account in the books. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json().catch(() => ({}));
    const ids = body.txnIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every(x => Number.isInteger(x))) {
      return Response.json({ error: 'txnIds must be 1-500 whole numbers' }, { status: 400 });
    }
    try {
      return Response.json(await ignoreMany(userId, ids as number[]));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
