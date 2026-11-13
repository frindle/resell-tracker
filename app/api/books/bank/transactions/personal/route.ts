import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { markPersonal } from '@/lib/books/bank/service';

/** Body { txnIds: number[] } (at most 500). Marks the open ones Personal; linked rows are skipped. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json().catch(() => ({}));
    const ids = body.txnIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every(x => Number.isInteger(x))) {
      return Response.json({ error: 'txnIds must be 1-500 whole numbers' }, { status: 400 });
    }
    return Response.json(await markPersonal(userId, ids as number[]));
  });
}
