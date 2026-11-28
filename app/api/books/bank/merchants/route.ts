import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { listMerchants, setMerchantKept, HttpError } from '@/lib/books/bank/service';

/** Open debits grouped by merchant, largest total first. Merchants marked "resell, keep" are left out; `?kept=1` includes them (each group has `kept`). */
export async function GET(req: NextRequest) {
  return withBooks(async userId => Response.json(await listMerchants(userId, req.nextUrl.searchParams.get('kept') === '1')));
}

/** Body { key: string, keep: boolean }. keep true marks the merchant reviewed (resell, keep); false puts it back. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json().catch(() => ({}));
    if (typeof body.key !== 'string' || typeof body.keep !== 'boolean') return Response.json({ error: 'key (text) and keep (true or false) are required' }, { status: 400 });
    try {
      return Response.json(await setMerchantKept(userId, body.key, body.keep));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
