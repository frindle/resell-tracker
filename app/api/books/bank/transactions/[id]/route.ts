import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { applyMatchAction, HttpError, type MatchAction } from '@/lib/books/bank/service';

/**
 * Body { action: 'accept' | 'link' | 'ignore' | 'personal' | 'cost' | 'reset' | 'deposit' | 'darkbloom' | 'shortfall', orderId?, orderIds?, choice?, orderNumber?, txnIds?, returnId?, duplicate? }.
 * Writes BankMatch links; the books change only when accounting.bankPosting is on.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (!['accept', 'link', 'ignore', 'personal', 'cost', 'reset', 'deposit', 'darkbloom', 'shortfall'].includes(body.action)) return Response.json({ error: 'action must be accept, link, ignore, personal, cost, reset, deposit, darkbloom or shortfall' }, { status: 400 });
    const ints = (v: unknown) => (Array.isArray(v) && v.every(x => Number.isInteger(x)) ? (v as number[]) : undefined);
    const act = {
      action: body.action,
      ...(Number.isInteger(body.orderId) ? { orderId: body.orderId } : {}),
      ...(typeof body.orderNumber === 'string' && body.orderNumber.trim() ? { orderNumber: body.orderNumber.trim().slice(0, 100) } : {}),
      ...(ints(body.orderIds) ? { orderIds: ints(body.orderIds) } : {}),
      ...(['fee', 'returns', 'more'].includes(body.choice) ? { choice: body.choice } : {}),
      ...(ints(body.txnIds) ? { txnIds: ints(body.txnIds) } : {}),
      ...(Number.isInteger(body.returnId) ? { returnId: body.returnId } : {}),
      ...(body.duplicate === true ? { duplicate: true } : {}),
      ...(typeof body.category === 'string' ? { category: body.category } : {}),
      ...(body.business === 'shared' || body.business === 'resell' ? { business: body.business } : {}),
      ...(typeof body.vendor === 'string' ? { vendor: body.vendor.slice(0, 120) } : {}),
      ...(typeof body.purpose === 'string' ? { purpose: body.purpose.slice(0, 200) } : {}),
      ...(Number.isInteger(body.businessPct) ? { businessPct: body.businessPct } : {}),
    } as MatchAction;
    try {
      return Response.json(await applyMatchAction(userId, Number(id), act));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
