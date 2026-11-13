import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { applyMatchAction, HttpError, type MatchAction } from '@/lib/books/bank/service';

/**
 * Body { action: 'accept' | 'ignore' | 'personal' | 'reset', orderId?, orderIds?, txnIds?, returnId?, duplicate? }.
 * Writes BankMatch links; the books change only when accounting.bankPosting is on.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (!['accept', 'ignore', 'personal', 'reset'].includes(body.action)) return Response.json({ error: 'action must be accept, ignore, personal or reset' }, { status: 400 });
    const ints = (v: unknown) => (Array.isArray(v) && v.every(x => Number.isInteger(x)) ? (v as number[]) : undefined);
    const act = {
      action: body.action,
      ...(body.orderId != null ? { orderId: Number(body.orderId) } : {}),
      ...(ints(body.orderIds) ? { orderIds: ints(body.orderIds) } : {}),
      ...(ints(body.txnIds) ? { txnIds: ints(body.txnIds) } : {}),
      ...(body.returnId != null ? { returnId: Number(body.returnId) } : {}),
      ...(body.duplicate === true ? { duplicate: true } : {}),
    } as MatchAction;
    try {
      return Response.json(await applyMatchAction(userId, Number(id), act));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
