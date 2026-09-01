import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';

function parseAmount(v: unknown): number {
  return parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
}
function parseAmountNullable(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const sessionUid = await getSessionUserId();
  const userId = resolveExtensionUserId(req, sessionUid);
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
  // Treat per-shipment label changes (trackingValues) as a change too —
  // editing those without touching trackingNumbers used to be silent.
  // Optimistic lock: reject if the record has been updated since the
  // client loaded it. The client sends the timestamp it saw on GET as
  // body.__ifUnmodifiedSince (ISO string). Legacy clients that don't
  // send it fall through to the previous last-write-wins behavior so
  // we don't break existing forms mid-deploy.
  const ifUnmodifiedSince = typeof body.__ifUnmodifiedSince === 'string' ? new Date(body.__ifUnmodifiedSince) : null;
  const incomingTracking = body.trackingNumbers || null;
  const incomingTrackingValues = body.trackingValues || null;
  const before = await prisma.order.findUnique({
    where: { id: parseInt(id), userId: userId ?? null },
    select: { trackingNumbers: true, trackingValues: true, updatedAt: true, userEditedAt: true },
  });
  const trackingChanged = before != null
    && (before.trackingNumbers !== incomingTracking
        || before.trackingValues !== incomingTrackingValues);

  // If the client provided the timestamp it loaded, reject when another
  // USER edit has landed since. Compare against userEditedAt, not
  // updatedAt: background syncs (CC/BFMR/auto-sync) bump updatedAt on
  // every order they touch, which used to 409 any form left open across
  // a sync ("modified by another session" with only one user). The
  // client's loaded updatedAt is always >= the userEditedAt at load time,
  // so userEditedAt > loaded timestamp means a real concurrent edit.
  // Second-precision — clients round-trip ISO strings and Prisma's
  // DateTime is millisecond-precise, so a raw !== would false-positive.
  if (ifUnmodifiedSince && before?.userEditedAt && !isNaN(ifUnmodifiedSince.getTime())) {
    const currentSec = Math.floor(before.userEditedAt.getTime() / 1000);
    const clientSec = Math.floor(ifUnmodifiedSince.getTime() / 1000);
    if (currentSec > clientSec) {
      return Response.json({
        error: 'stale',
        detail: 'Order was modified by another session. Reload and retry.',
        currentUpdatedAt: before.updatedAt.toISOString(),
      }, { status: 409 });
    }
  }

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
      portalCashback: parseAmountNullable(body.portalCashback),
      amexOfferDollars: parseAmountNullable(body.amexOfferDollars),
      amexOfferPoints: parseAmountNullable(body.amexOfferPoints),
      shippingAddress: body.shippingAddress || null,
      notes: body.notes || null,
      groupReferenceId: body.groupReferenceId || null,
      trackingValues: body.trackingValues || null,
      trackingNumbers: incomingTracking,
      overdueAt: body.overdueAt ? new Date(body.overdueAt) : null,
      deliveryDeadline: body.deliveryDeadline ? new Date(body.deliveryDeadline) : null,
      ...(trackingChanged ? { trackingSubmittedToBg: false } : {}),
      // Stamp interactive saves (form sends __ifUnmodifiedSince) so the
      // next optimistic-lock check has a user-edit baseline to compare.
      ...(ifUnmodifiedSince ? { userEditedAt: new Date() } : {}),
    },
    include: { buyer: true, card: true },
  });

  // If the order has BG commitment links, re-run recalcSalePrice so the
  // commitment-derived salePrice + bgExpectedPayout aren't clobbered by
  // a stale form Save. The order form loads before the link is created,
  // so body.salePrice arrives as null and would otherwise overwrite the
  // derived value. Respects locked — user who wants a manual override
  // must lock the order first.
  const linkCount = await prisma.orderCommitmentLink.count({ where: { orderId: order.id } });
  if (linkCount > 0) {
    const { recalcSalePrice } = await import('@/lib/commitmentSalePrice');
    try { await recalcSalePrice(order.id); }
    catch (e) { console.warn(`[PUT /api/orders/:id] recalcSalePrice failed on ${order.id}:`, e); }
  }

  // Same guard for BFMR reservation links: linking doesn't bump
  // userEditedAt (it's not a form save), so a form opened before the link
  // no longer 409s — its stale salePrice would clobber the link-derived
  // value without this re-derivation.
  const bfmrLinkCount = await prisma.orderBfmrLink.count({ where: { orderId: order.id } });
  if (bfmrLinkCount > 0) {
    const { recalcBfmrSalePrice } = await import('@/lib/bfmrSalePrice');
    try { await recalcBfmrSalePrice(order.id); }
    catch (e) { console.warn(`[PUT /api/orders/:id] recalcBfmrSalePrice failed on ${order.id}:`, e); }
  }

  // And for CC orders: salePrice is derived (sum of per-card paid values,
  // maintained by cardcenter/sync-payments). Re-derive so a stale form
  // save can't clobber it between syncs. Respects locked, like the others.
  const ccSum = await prisma.giftCard.aggregate({
    where: { orderId: order.id, ccPurchasePrice: { not: null } },
    _sum: { ccPurchasePrice: true },
  });
  if (ccSum._sum.ccPurchasePrice != null && ccSum._sum.ccPurchasePrice > 0) {
    const salePrice = Math.round(ccSum._sum.ccPurchasePrice * 100) / 100;
    await prisma.order.updateMany({ where: { id: order.id, locked: false }, data: { salePrice } });
  }

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
  // If recalc ran, the response `order` still has the stale (pre-recalc)
  // salePrice. Re-read so the client sees the recalc-derived value.
  if (linkCount > 0) {
    const post = await prisma.order.findUnique({
      where: { id: parseInt(id), userId: userId ?? null },
      include: { buyer: true, card: true },
    });
    if (post) return Response.json(post);
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

const PATCHABLE_FIELDS = new Set(['salePriceSynced', 'overdueAt', 'deliveryDeadline', 'trackingNumbers', 'trackingValues', 'notes', 'bgExpectedPayout', 'lost', 'salePrice', 'bfmrStatus', 'cost', 'shippingCost', 'insuranceCost', 'cashbackAmount', 'portalCashback', 'itemDescription', 'shippingAddress']);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const sessionUid = await getSessionUserId();
  const userId = resolveExtensionUserId(req, sessionUid);
  const { id } = await params;
  const body = await req.json() as Record<string, unknown>;

  // The lock is the user's "this is settled" switch and rightly blocks routine
  // edits. It must NOT block a correction the order's own data forces. That is
  // the same reasoning lib/orderReturns.ts states for recalcReturnedCost and
  // lib/bfmrSalePrice.ts for recalcBfmrSalePrice, both of which deliberately
  // carry no `locked: false` guard: the lock must not block the correction a
  // return itself is supposed to trigger.
  //
  // Order 832 is the case. A return dropped the cost basis, OrderForm recomputed
  // cashback to the correct netted figure -- $36.00, being (899.97 - 299.99) at
  // 6% -- auto-PATCHed it, and this guard rejected the write because the order
  // had been locked when it was paid. The right number, permanently unable to
  // persist, with the UI retrying on every edit forever.
  //
  // Scoped as narrowly as it goes: ONLY a patch whose single field is
  // cashbackAmount is exempt. Any other field, or cashbackAmount sent alongside
  // anything else, still hits the lock. This covers the derived-value correction
  // without opening locked orders to general editing.
  const patchKeys = Object.keys(body).filter(k => PATCHABLE_FIELDS.has(k));
  const isCashbackOnlyCorrection = patchKeys.length === 1 && patchKeys[0] === 'cashbackAmount';
  if (!isCashbackOnlyCorrection) {
    const lockErr = await requireOrderUnlocked(parseInt(id), userId ?? null);
    if (lockErr) return lockErr;
  }

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
    // never be re-sent. Cover trackingValues too — per-shipment label edits
    // are still user-meaningful changes that warrant a resubmit.
    let trackingChanged = false;
    const touchesNumbers = Object.prototype.hasOwnProperty.call(data, 'trackingNumbers');
    const touchesValues = Object.prototype.hasOwnProperty.call(data, 'trackingValues');
    if (touchesNumbers || touchesValues) {
      const before = await prisma.order.findUnique({
        where: { id: parseInt(id) },
        select: { trackingNumbers: true, trackingValues: true },
      });
      if (before) {
        const numsDiff = touchesNumbers && before.trackingNumbers !== data.trackingNumbers;
        const valsDiff = touchesValues && before.trackingValues !== data.trackingValues;
        if (numsDiff || valsDiff) {
          trackingChanged = true;
          data.trackingSubmittedToBg = false;
        }
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
