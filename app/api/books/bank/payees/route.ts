import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { listPayees, setPayee, HttpError } from '@/lib/books/bank/service';

/** The learned payer names (ACH / direct deposit only) and the buyer each narrows to; shared ones narrow nothing. */
export async function GET() {
  return withBooks(async userId => Response.json({ payees: await listPayees(userId) }));
}

/** Tie a payer name to a buyer: `{ description: "ACH: SOME PAYER", buyerId: 2 }` (buyerId null: the name narrows nothing). */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const b = await req.json().catch(() => null) as { description?: unknown; buyerId?: unknown } | null;
    const buyerId = b?.buyerId === null ? null : Number(b?.buyerId);
    if (typeof b?.description !== 'string' || (buyerId !== null && !Number.isInteger(buyerId))) {
      return Response.json({ error: 'need description (string) and buyerId (integer or null)' }, { status: 400 });
    }
    try {
      return Response.json(await setPayee(userId, b.description, buyerId));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
