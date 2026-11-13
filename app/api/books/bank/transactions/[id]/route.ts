import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { applyMatchAction, HttpError, type MatchAction } from '@/lib/books/bank/service';

/** Body { action: 'accept' | 'ignore' | 'reset', orderId? }. Only matchStatus and match refs change; nothing is posted. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (!['accept', 'ignore', 'reset'].includes(body.action)) return Response.json({ error: 'action must be accept, ignore or reset' }, { status: 400 });
    try {
      return Response.json(await applyMatchAction(userId, Number(id), { action: body.action, ...(body.orderId != null ? { orderId: Number(body.orderId) } : {}) } as MatchAction));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
