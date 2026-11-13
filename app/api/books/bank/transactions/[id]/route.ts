import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { applyMatchAction, HttpError, type MatchAction } from '@/lib/books/bank/service';

/**
 * Body { action: 'accept' | 'link' | 'ignore' | 'personal' | 'reset', orderId?, orderNumber?, txnIds?, returnId?, duplicate? }.
 * Writes BankMatch links; the books change only when accounting.bankPosting is on.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (!['accept', 'link', 'ignore', 'personal', 'reset'].includes(body.action)) return Response.json({ error: 'action must be accept, link, ignore, personal or reset' }, { status: 400 });
    const ints = (v: unknown) => (Array.isArray(v) && v.every(x => Number.isInteger(x)) ? (v as number[]) : undefined);
    const act = {
      action: body.action,
      ...(Number.isInteger(body.orderId) ? { orderId: body.orderId } : {}),
      ...(typeof body.orderNumber === 'string' && body.orderNumber.trim() ? { orderNumber: body.orderNumber.trim().slice(0, 100) } : {}),
      ...(ints(body.txnIds) ? { txnIds: ints(body.txnIds) } : {}),
      ...(Number.isInteger(body.returnId) ? { returnId: body.returnId } : {}),
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
