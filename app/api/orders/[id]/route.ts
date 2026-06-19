import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

function parseAmount(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}
function parseAmountNullable(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id: parseInt(id), userId: userId ?? null },
    include: { buyer: true, card: true },
  });
  if (!order) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(order);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const lockErr = await requireOrderUnlocked(parseInt(id), userId ?? null);
  if (lockErr) return lockErr;
  const body = await req.json();
  const orderDate = new Date(body.orderDate);
  if (isNaN(orderDate.getTime())) {
    return Response.json({ error: 'Invalid orderDate' }, { status: 400 });
  }
  try {
  const order = await prisma.order.update({
    where: { id: parseInt(id), userId: userId ?? null },
    data: {
      platform: body.platform,
      orderNumber: body.orderNumber || null,
      orderDate,
      itemDescription: body.itemDescription || null,
      cost: parseAmount(body.cost),
      shippingCost: parseAmount(body.shippingCost),
      insuranceCost: parseAmount(body.insuranceCost),
      salePrice: parseAmountNullable(body.salePrice),
      buyerId: body.buyerId ? parseInt(body.buyerId) : null,
      cardId: body.cardId ? parseInt(body.cardId) : null,
      cashbackAmount: parseAmount(body.cashbackAmount),
      shippingAddress: body.shippingAddress || null,
      notes: body.notes || null,
      groupReferenceId: body.groupReferenceId || null,
      trackingValues: body.trackingValues || null,
      trackingNumbers: body.trackingNumbers || null,
      overdueAt: body.overdueAt ? new Date(body.overdueAt) : null,
    },
    include: { buyer: true, card: true },
  });
  return Response.json(order);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[PUT /api/orders/:id]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

const PATCHABLE_FIELDS = new Set(['salePriceSynced', 'overdueAt', 'trackingNumbers', 'notes', 'bgExpectedPayout', 'lost', 'salePrice', 'returnStatus', 'returnTracking', 'cost', 'shippingCost', 'insuranceCost']);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const lockErr = await requireOrderUnlocked(parseInt(id), userId ?? null);
  if (lockErr) return lockErr;
  const body = await req.json() as Record<string, unknown>;

  // Only allow specific fields to be patched
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (PATCHABLE_FIELDS.has(key)) data[key] = body[key];
  }
  if (Object.keys(data).length === 0) {
    return Response.json({ error: 'No patchable fields provided' }, { status: 400 });
  }
  // Marking paid should always clear the overdue flag
  if (data.salePriceSynced === true) data.overdueAt = null;

  try {
    const order = await prisma.order.update({
      where: { id: parseInt(id), userId: userId ?? null },
      data,
    });
    return Response.json(order);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[PATCH /api/orders/:id]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}


export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const lockErr = await requireOrderUnlocked(parseInt(id), userId ?? null);
  if (lockErr) return lockErr;
  const order = await prisma.order.findUnique({ where: { id: parseInt(id), userId: userId ?? null }, select: { orderNumber: true, groupReferenceId: true } });
  if (!order) return new Response(null, { status: 404 });
  await prisma.order.delete({ where: { id: parseInt(id), userId: userId ?? null } });
  for (const num of [order.orderNumber, order.groupReferenceId].filter(Boolean) as string[]) {
    await prisma.bfmrSkip.upsert({ where: { orderNumber: num }, create: { orderNumber: num }, update: {} });
  }
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
