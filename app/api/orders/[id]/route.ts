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
  // Detect tracking change so we can re-trigger BG auto-submit. The
  // order-detail form posts via PUT (not PATCH), so without this hook a
  // user who edits tracking on the form would never get it pushed to BG.
  const incomingTracking = body.trackingNumbers || null;
  const before = await prisma.order.findUnique({
    where: { id: parseInt(id), userId: userId ?? null },
    select: { trackingNumbers: true },
  });
  const trackingChanged = before != null && before.trackingNumbers !== incomingTracking;

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
      trackingNumbers: incomingTracking,
      overdueAt: body.overdueAt ? new Date(body.overdueAt) : null,
      ...(trackingChanged ? { trackingSubmittedToBg: false } : {}),
    },
    include: { buyer: true, card: true },
  });
  if (trackingChanged && order.trackingNumbers) {
    const { autoSubmitTrackingForOrders } = await import('@/lib/autoSubmitTracking');
    console.log(`[bg-submit/put] tracking changed on order ${order.id}, before="${before?.trackingNumbers ?? ''}" after="${order.trackingNumbers}"`);
    // Await so the response — and the form's subsequent router.refresh()
    // — sees the final post-submission state. Without this, the form
    // reloads while autoSubmitTrackingForOrders is still in flight and
    // the page momentarily shows "tracking not submitted" / "no tracking
    // in group" before flipping correct a moment later.
    try {
      await autoSubmitTrackingForOrders(userId ?? null, [order.id], 'put');
    } catch { /* helper logs its own errors; don't fail the save */ }
    // Re-read the order so trackingSubmittedToBg etc. reflect the post-submit state.
    const refreshed = await prisma.order.findUnique({
      where: { id: parseInt(id), userId: userId ?? null },
      include: { buyer: true, card: true },
    });
    if (refreshed) return Response.json(refreshed);
  }
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

const PATCHABLE_FIELDS = new Set(['salePriceSynced', 'overdueAt', 'trackingNumbers', 'notes', 'bgExpectedPayout', 'lost', 'salePrice', 'returnStatus', 'returnTracking', 'cost', 'shippingCost', 'insuranceCost', 'itemDescription', 'shippingAddress']);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const sessionUid = await getSessionUserId();
  const headerUid = req.headers.get('X-Extension-User-Id');
  const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);
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
    // If tracking changed, reset the submitted-to-BG flag so the auto-submit
    // helper re-attempts. Without this, a manually edited tracking would
    // never be re-sent.
    let trackingChanged = false;
    if (Object.prototype.hasOwnProperty.call(data, 'trackingNumbers')) {
      const before = await prisma.order.findUnique({
        where: { id: parseInt(id) },
        select: { trackingNumbers: true },
      });
      if (before && before.trackingNumbers !== data.trackingNumbers) {
        trackingChanged = true;
        data.trackingSubmittedToBg = false;
      }
    }
    const order = await prisma.order.update({
      where: { id: parseInt(id), userId: userId ?? null },
      data,
    });
    if (trackingChanged && order.trackingNumbers) {
      const { autoSubmitTrackingForOrders } = await import('@/lib/autoSubmitTracking');
      // Fire-and-forget — errors land in logs.
      void autoSubmitTrackingForOrders(userId ?? null, [order.id], 'patch');
    }
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
