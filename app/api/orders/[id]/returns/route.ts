import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { getReturnableLines, recalcAfterReturnChange, isReturnStatus } from '@/lib/orderReturns';
import { NextRequest } from 'next/server';

async function ownedOrder(orderId: number) {
  const userId = await getSessionUserId();
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  return { userId: userId ?? null, ok: !!order };
}

async function payload(orderId: number) {
  const [lines, returns, order] = await Promise.all([
    getReturnableLines(orderId),
    prisma.orderReturn.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    prisma.order.findUnique({
      where: { id: orderId },
      select: { cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, salePrice: true },
    }),
  ]);
  return { lines, returns, order };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const orderId = parseInt((await params).id);
    const { ok } = await ownedOrder(orderId);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(await payload(orderId));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const orderId = parseInt((await params).id);
    const { userId, ok } = await ownedOrder(orderId);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    const lockErr = await requireOrderUnlocked(orderId, userId);
    if (lockErr) return lockErr;

    const body = await req.json() as {
      lineKey: string;
      quantity: number;
      status?: string;
      requestedAt?: string | null;
      notes?: string | null;
    };

    const lines = await getReturnableLines(orderId);
    const line = lines.find(l => l.key === body.lineKey);
    if (!line) return Response.json({ error: 'Unknown line' }, { status: 400 });

    const quantity = Math.floor(Number(body.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      return Response.json({ error: 'Quantity must be at least 1' }, { status: 400 });
    }
    const status = body.status && isReturnStatus(body.status) ? body.status : 'requested';

    // Can't return more units than the line actually has, counting what's
    // already been returned — that would drive sold units negative and
    // silently inflate the cost write-off. Re-counted inside the transaction
    // so a double-submit (double-click, retry) can't slip past a stale read.
    const remaining = await prisma.$transaction(async tx => {
      const already = await tx.orderReturn.findMany({
        where: { orderId, bfmrLinkId: line.bfmrLinkId, commitmentLinkId: line.commitmentLinkId },
        select: { quantity: true },
      });
      const left = line.quantity - already.reduce((s, r) => s + r.quantity, 0);
      if (quantity > left) return left;
      await tx.orderReturn.create({
        data: {
          orderId,
          bfmrLinkId: line.bfmrLinkId,
          commitmentLinkId: line.commitmentLinkId,
          itemName: line.itemName,
          trackingNumber: line.trackingNumber,
          quantity,
          status,
          requestedAt: body.requestedAt ? new Date(body.requestedAt) : new Date(),
          notes: body.notes || null,
        },
      });
      return null;
    });
    if (remaining !== null) {
      return Response.json(
        { error: `Only ${remaining} of ${line.quantity} unit${line.quantity === 1 ? '' : 's'} left to return on this line` },
        { status: 400 },
      );
    }
    await recalcAfterReturnChange(orderId);
    return Response.json(await payload(orderId));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const orderId = parseInt((await params).id);
    const { userId, ok } = await ownedOrder(orderId);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    const lockErr = await requireOrderUnlocked(orderId, userId);
    if (lockErr) return lockErr;

    const body = await req.json() as {
      returnId: number;
      status?: string;
      refundAmount?: number | null;
      notes?: string | null;
    };
    const existing = await prisma.orderReturn.findFirst({ where: { id: body.returnId, orderId } });
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (body.status != null) {
      if (!isReturnStatus(body.status)) return Response.json({ error: 'Bad status' }, { status: 400 });
      data.status = body.status;
      if (body.status === 'received' && !existing.receivedAt) data.receivedAt = new Date();
      if (body.status === 'refunded' && !existing.refundedAt) data.refundedAt = new Date();
      // Stepping back out of refunded drops the refund stamp so the cost
      // write-off falls back to the per-unit estimate instead of keeping a
      // refund that no longer applies.
      if (body.status !== 'refunded') { data.refundedAt = null; data.refundAmount = null; }
    }
    if ('refundAmount' in body) {
      const amt = body.refundAmount;
      if (amt != null && (!Number.isFinite(amt) || amt < 0)) {
        return Response.json({ error: 'Invalid refund amount' }, { status: 400 });
      }
      data.refundAmount = amt ?? null;
    }
    if ('notes' in body) data.notes = body.notes || null;
    if (Object.keys(data).length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    await prisma.orderReturn.update({ where: { id: body.returnId }, data });
    await recalcAfterReturnChange(orderId);
    return Response.json(await payload(orderId));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const orderId = parseInt((await params).id);
    const { userId, ok } = await ownedOrder(orderId);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    const lockErr = await requireOrderUnlocked(orderId, userId);
    if (lockErr) return lockErr;

    const { returnId } = await req.json() as { returnId: number };
    await prisma.orderReturn.deleteMany({ where: { id: returnId, orderId } });
    await recalcAfterReturnChange(orderId);
    return Response.json(await payload(orderId));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
