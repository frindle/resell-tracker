import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import { cloudflareCreds, INBOX_MODE_KEY } from '@/lib/emailCreds';
import { fetchCloudflareOrderEmails, deleteCloudflareMessages, type ParsedCache, type CloudflareCreds } from '@/lib/emailCloudflare';
import { mergeEmailImportRows } from '@/lib/emailParse';
import { planAutoImport, parseMissLine, heldSummary, needsAttention, digitsOf, trackingNudgeText, cancelAction, cancelFillsItem, cancelNoteText, type HeldEmail, type ShippedNoTracking, type UserBatch, type CancelEmail, type CancelNote, type DelayEmail, type BgExpiryEmail, type BgPriceChangeEmail, type PaymentEmail } from '@/lib/emailAutoImportPlan';
import { applyPayments, type PayPalDb } from '@/lib/paypalApplyDb';
import { cancelOrder, releaseCancelledOrder, type ReleasedLink } from '@/lib/orderCancel';
import { planBfmrCancel, type BfmrLine, type BfmrCancelPlan } from '@/lib/bfmrCancelPlan';
import { getBfmrRestCreds, cancelReservationsRest } from '@/lib/bfmrDeals';
import { MERCHANTS_KEY, parseLearnedMerchants } from '@/lib/merchants';
import { queueEmailVisits } from '@/lib/amazonVisitQueue';
import { trackingUserId } from '@/lib/amazonTracking';
import { planGapFill, gapFillLine, isUselessDescription, type GapOrder } from '@/lib/gapFill';
import { withDelayNote, withCancelledTotal, hasCancelledTotal, addLine } from '@/lib/orderNotes';
import { CANCEL_REDUCE_KEY, cancelReduceOn, bgOutcomeLine, cancelledItem, planPartialCancel, planBfmrPartial, partialNoteLine, type PartialLine } from '@/lib/cancelReducePlan';
import { reduceBgCommitments } from '@/lib/cancelReduceRun';
import { planCommitmentExpiry, EXPIRED, type CommitmentRow } from '@/lib/commitmentExpiry';
import { backfillTargets, fillsFromArchive, backfillLine, runBackfillOnce, digits as backfillDigits } from '@/lib/cancelledBackfill';
import { kickSidecarPoll } from '@/lib/sidecarKick';
import { commandTarget } from '@/lib/commandWorker';
import { alertCouldNotGet } from '@/lib/fillFailureRun';
import { runBgReceiptSync } from '@/lib/bgSync';
import { unmatchedReceipts, shouldRunReceiptSync, freshAlerts, alertKey, receiptAlertText, planReceiptFailure, receiptSyncOutcome, dueUserFailAlerts, userSyncFailText, NO_RECEIPT_FAILURES, type ReceiptSyncSummary, type ReceiptFailState, type BgReceiptEmail } from '@/lib/bgReceiptEmail';
import { gated } from './primaryFlag.ts';
import { sameTerms, termsAfter } from '@/lib/bgPriceChange';
import { repriceCommitmentOrders, previewCommitmentReprice, notifyPriceChange, worthTelling } from '@/lib/commitmentReprice';
import { loopbackPost } from '@/lib/autoSync';
import { ingestEgiftEmails, sweepEgiftScrapes } from '@/lib/egiftIngestDb';
import { backfillEgiftFromArchive, egiftBackfillLine, EGIFT_BACKFILL_KEY } from '@/lib/egiftBackfill';

// Automatic order-email import. Every 5 minutes it reads the Cloudflare order
// inbox, imports what the Email tab would import by default (see
// emailAutoImportPlan.ts), and removes those emails from the inbox. Emails it
// leaves behind wait on the Email tab; each one gets one PII-free log line and
// one Pushover note to its user (or to everyone when no user claims it).
//
// Turned off with the global setting email_auto_import = "off".

const POLL_MS = 5 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;
export const AUTO_IMPORT_KEY = 'email_auto_import';
const ALERTED_KEY = 'email_auto_import_alerted';
const ALERTED_MAX = 500;

const cache: ParsedCache = new Map();
let running = false;
let lastReceiptSyncAt: number | null = null;
let receiptFail: ReceiptFailState = NO_RECEIPT_FAILURES;
const userFailAlertAt = new Map<number, number>();

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

// The import route is the one place orders are created and updated (buyer
// match, cards, tracking submit, BFMR auto-link, books). Call it over loopback
// as the user, the way lib/autoSync.ts calls the sync routes.
async function importAs(uid: number, rows: unknown[]): Promise<Record<string, number>> {
  const secret = process.env.EXTENSION_SHARED_SECRET;
  const res = await fetch(`${baseUrl()}/api/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-User-Id': String(uid),
      ...(secret ? { 'X-Extension-Secret': secret } : {}),
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/api/import → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

async function alertedIds(): Promise<string[]> {
  try {
    const v = JSON.parse((await getSetting(null, ALERTED_KEY))?.value ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function notify(userIds: number[], message: string): Promise<void> {
  for (const uid of userIds) {
    const [key, token] = await Promise.all([getSetting(uid, 'pushover_user_key'), getSetting(uid, 'pushover_app_token')]);
    if (!key?.value || !token?.value) continue;
    await sendPushover(key.value, token.value, message, 'Order email').catch(e => console.error('[email-auto-import] pushover failed:', String(e).slice(0, 160)));
  }
}

async function alertHeld(held: HeldEmail[], allUserIds: number[]): Promise<void> {
  const worth = held.filter(h => needsAttention(h.reason));
  if (!worth.length) return;
  const seen = await alertedIds();
  const fresh = worth.filter(h => !seen.includes(h.id));
  if (!fresh.length) return;
  for (const h of fresh) console.log(parseMissLine(h));

  const byUser = new Map<number | null, HeldEmail[]>();
  for (const h of fresh) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);
  for (const [uid, list] of byUser) await notify(uid == null ? allUserIds : [uid], heldSummary(list));

  // Inbox mail expires after 30 days, so the newest ids are all that matter.
  await upsertSetting(null, ALERTED_KEY, JSON.stringify([...seen, ...fresh.map(h => h.id)].slice(-ALERTED_MAX)));
}

// Orders that shipped with no tracking number in the email and still have none
// after the import (another email or a sync may have filled it in). Amazon
// orders on the sidecar's account are looked up automatically (sidecar first,
// then the Brave extension: lib/amazonTracking.ts); everything else gets one note.
async function nudgeMissingTracking(list: ShippedNoTracking[], importedUsers: ReadonlySet<number>): Promise<void> {
  const byUser = new Map<number, ShippedNoTracking[]>();
  for (const x of list) if (importedUsers.has(x.userId)) byUser.set(x.userId, [...(byUser.get(x.userId) ?? []), x]);
  for (const [uid, items] of byUser) {
    const bare = await prisma.order.findMany({
      where: { userId: uid, cancelled: false, OR: [{ trackingNumbers: null }, { trackingNumbers: '' }] },
      select: { orderNumber: true },
    });
    const fullNumber = new Map(bare.map(o => [digitsOf(o.orderNumber), String(o.orderNumber ?? '')]));
    const seen = new Set<string>();
    let still = items.filter(x => fullNumber.has(x.order) && !seen.has(x.order) && seen.add(x.order));
    // Walmart orders on the sidecar's account get their tracking from the
    // Walmart sync that fillGaps queued, so no note for those.
    if (uid === trackingUserId()) still = still.filter(x => x.platform !== 'Walmart');
    if (!still.length) continue;
    for (const x of still) console.log(`[email-parse-miss] platform=${x.platform} kind=shipped reason=shipped-without-tracking user=${uid}`);

    const amazon = still.filter(x => x.platform === 'Amazon');
    if (amazon.length) {
      // The visit queue (queueEmailVisits, run just before) takes these for the
      // browser's account; for any other user's Amazon orders the note stays.
      if (uid === trackingUserId()) still = still.filter(x => x.platform !== 'Amazon');
    }
    if (still.length) await notify([uid], trackingNudgeText(still));
  }
}

// Orders just imported for the sidecar's account that are still missing an
// item, address, tracking number or (Costco) card queue the store's page
// lookup now rather than waiting for the next scheduled sync (lib/gapFill.ts). The sidecar (Walmart) and the
// browser (Costco) are each signed in to one account, so other users' orders are left to the email and the
// AI backup parser.
// One waiting SYNC_COSTCO_ORDER takes the new orders too, rather than a
// second row per email. It runs in the browser extension, which is signed in
// to the Costco account of the tracker user it is set up as, so only that
// user's orders are queued; other users' orders wait for the email.
async function queueCostcoDetails(uid: number, orderNumbers: string[]): Promise<void> {
  if (uid !== trackingUserId()) {
    console.log(`[gap-fill] Costco details not queued: user is not the browser's account orders=${orderNumbers.length}`);
    return;
  }
  await queueOrderDetails('SYNC_COSTCO_ORDER', uid, orderNumbers);
}

// One waiting per-order command of this type for this user takes more
// orders too. The payload names the user so a later failure note goes only to
// the order's owner. The worker (sidecar or extension) comes from
// lib/commandWorker.ts.
async function queueOrderDetails(type: 'SYNC_COSTCO_ORDER' | 'SYNC_WALMART_ORDER', uid: number, orderNumbers: string[]): Promise<void> {
  const targetBrowser = commandTarget(type);
  const pending = await prisma.extensionCommand.findMany({ where: { type, targetBrowser, status: 'pending' }, select: { id: true, payload: true } });
  const parse = (payload: string | null): { orderNumbers?: unknown; userId?: unknown } => { try { return JSON.parse(payload ?? '{}'); } catch { return {}; } };
  const waiting = pending.find(c => parse(c.payload).userId === uid);
  if (!waiting) {
    await prisma.extensionCommand.create({ data: { type, targetBrowser, payload: JSON.stringify({ orderNumbers, userId: uid }) } });
    return;
  }
  const had = (Array.isArray(parse(waiting.payload).orderNumbers) ? parse(waiting.payload).orderNumbers as unknown[] : []).map(String);
  const merged = [...new Set([...had, ...orderNumbers])];
  if (merged.length !== had.length) await prisma.extensionCommand.update({ where: { id: waiting.id }, data: { payload: JSON.stringify({ orderNumbers: merged, userId: uid }) } });
}

// `cancelled` names cancelled orders (digits only) to fill like live ones: item,
// card and address from the order page, never tracking. Other cancelled orders
// are left alone.
async function fillGaps(batch: UserBatch | undefined, uid: number, cancelled: ReadonlySet<string> = new Set()): Promise<void> {
  if (!batch?.inputs.length && !cancelled.size) return;
  const wanted = new Set([...(batch?.inputs ?? []).map(i => digitsOf(i.orderNumber)).filter(Boolean), ...cancelled]);
  const shipped = new Set((batch?.inputs ?? []).filter(i => i.kind !== 'ordered').map(i => digitsOf(i.orderNumber)));
  const rows = await prisma.order.findMany({
    where: { userId: uid, orderNumber: { not: null }, platform: { in: ['Walmart', 'Costco', 'Amazon'] }, ...(cancelled.size ? {} : { cancelled: false }) },
    select: { platform: true, orderNumber: true, itemDescription: true, shippingAddress: true, trackingNumbers: true, cardId: true, cancelled: true, buyerId: true },
    orderBy: { id: 'desc' },
    take: 500,
  });
  const orders: GapOrder[] = rows
    .filter(o => wanted.has(digitsOf(o.orderNumber)) && (!o.cancelled || cancelled.has(digitsOf(o.orderNumber))))
    .map(o => ({ ...o, platform: String(o.platform ?? ''), orderNumber: String(o.orderNumber ?? ''), shipped: shipped.has(digitsOf(o.orderNumber)) && !o.cancelled }));
  await queueGapFill(uid, orders);
}

/**
 * Queues the store's per-order page read for each order that still lacks
 * something its page can give (item, address, tracking, card, group). Returns
 * the queued counts per store.
 */
export async function queueGapFill(uid: number, orders: readonly GapOrder[]): Promise<{ walmart: number; costco: number; amazon: number }> {
  // Amazon orders go through the visit queue (queueEmailVisits), not from here.
  const plan = { ...planGapFill(orders), amazonOrders: [] as string[] };
  const counts = { walmart: plan.walmartOrders.length, costco: plan.costcoOrders.length, amazon: plan.amazonOrders.length };
  if (!counts.walmart && !counts.costco && !counts.amazon) return counts;
  console.log(gapFillLine(orders, plan));

  if (plan.walmartOrders.length) await queueOrderDetails('SYNC_WALMART_ORDER', uid, plan.walmartOrders);
  if (plan.costcoOrders.length) await queueCostcoDetails(uid, plan.costcoOrders);
  kickSidecarPoll();
  return counts;
}

// Cancellation emails for orders in the tracker. A whole-order cancellation
// cancels the order the way its Cancel button does and releases the group
// units it held; one that was already cancelled only has its leftover links
// released. Locked orders wait for a person; so do partial cancellations, after
// the one line they name (when they name exactly one) has its units released.
// Returns the email ids that are done with.
/** Every BFMR line sharing a reserve id with the order's linked reservations. */
async function bfmrLinesFor(orderId: number, userId: number): Promise<BfmrLine[]> {
  const linked = await prisma.orderBfmrLink.findMany({ where: { orderId }, select: { reservationId: true, reservation: { select: { reserveId: true } } } });
  if (!linked.length) return [];
  const reserveIds = [...new Set(linked.map(l => l.reservation.reserveId).filter((r): r is string => !!r))];
  const rows = await prisma.bfmrReservation.findMany({
    where: { userId, OR: [{ id: { in: linked.map(l => l.reservationId) } }, ...(reserveIds.length ? [{ reserveId: { in: reserveIds } }] : [])] },
    select: { reserveId: true, status: true, qty: true, retailPrice: true, bfmrOrderId: true, orderLinks: { select: { orderId: true, quantity: true } } },
  });
  return rows.map(r => ({ reserveId: r.reserveId, status: r.status, qty: r.qty, retailPrice: r.retailPrice, bfmrOrderId: r.bfmrOrderId, links: r.orderLinks }));
}

/** Cancels the reservations that matched on BFMR; never throws. */
async function cancelOnBfmr(orderId: number, userId: number, plan: BfmrCancelPlan, opts: { wholeOrder?: boolean } = {}): Promise<{ cancelled: number; left: string[] }> {
  const left = [...plan.left];
  let cancelled = 0;
  if (plan.cancel.length) {
    try {
      const creds = await getBfmrRestCreds(userId);
      if (!creds) {
        left.push(...plan.cancel.map(() => 'no BFMR API key in Settings'));
      } else {
        const refused = new Set(await cancelReservationsRest(creds, plan.cancel));
        const ok = plan.cancel.filter(r => !refused.has(r));
        left.push(...plan.cancel.filter(r => refused.has(r)).map(() => 'BFMR refused the cancel (already purchased or closed there)'));
        if (ok.length) {
          await prisma.bfmrReservation.updateMany({ where: { userId, reserveId: { in: ok } }, data: { status: 'cancelled' } });
          // A partial cancel leaves the order's other lines alone.
          if (opts.wholeOrder !== false) await prisma.order.update({ where: { id: orderId }, data: { bfmrStatus: 'cancelled' } });
        }
        cancelled = ok.length;
      }
    } catch (e) {
      left.push(...plan.cancel.map(() => 'the BFMR call failed'));
      console.error(`[email-auto-cancel] bfmr cancel failed for user ${userId}:`, String(e).slice(0, 160));
    }
  }
  console.log(`[email-auto-cancel] bfmr cancelled=${cancelled} left=${left.length} user=${userId}`);
  return { cancelled, left };
}

/** BuyingGroup lines for a cancel note: what the released commitment units did to BG (or would, with the setting off). */
async function bgReduceLines(uid: number, released: readonly ReleasedLink[], enabled: boolean): Promise<string[]> {
  const bg = released.filter(r => r.group === 'BuyingGroup' && r.commitmentId != null);
  if (!bg.length) return [];
  const outcomes = await reduceBgCommitments(uid, bg.map(r => ({ commitmentId: r.commitmentId!, name: r.name, quantity: r.quantity })), enabled);
  return outcomes.map(bgOutcomeLine);
}

type PartialOrder = { id: number; orderNumber: string | null; cost: number; notes: string | null };

/**
 * A partial cancel that names exactly one linked line: that line's link loses
 * the cancelled units and the dated order note records it (the note is also
 * what stops a re-read email applying twice). The order's cost is left for a
 * person. Then the group side: BG is reduced, and BFMR cancelled only for a
 * whole reserve id that is this order's alone. Returns null when the email is
 * ambiguous (nothing changed), 'already' when this email was applied before.
 */
async function applyPartialCancel(o: PartialOrder, c: CancelEmail, uid: number, enabled: boolean): Promise<CancelNote | 'already' | null> {
  const [bg, bfmr, bigsky] = await Promise.all([
    prisma.orderCommitmentLink.findMany({ where: { orderId: o.id }, select: { id: true, quantity: true, commitmentId: true, commitment: { select: { dealTitle: true } } } }),
    prisma.orderBfmrLink.findMany({ where: { orderId: o.id }, select: { id: true, quantity: true, reservationId: true, reservation: { select: { reserveId: true, itemName: true, dealTitle: true } } } }),
    prisma.orderBigSkyLink.findMany({ where: { orderId: o.id }, select: { id: true, quantity: true, commitmentId: true, commitment: { select: { itemName: true } } } }),
  ]);
  const lines: PartialLine[] = [
    ...bg.map(l => ({ group: 'BuyingGroup' as const, linkId: l.id, name: l.commitment.dealTitle, quantity: l.quantity, targetId: l.commitmentId })),
    ...bfmr.map(l => ({ group: 'BFMR' as const, linkId: l.id, name: l.reservation.itemName ?? l.reservation.dealTitle ?? '', quantity: l.quantity, targetId: l.reservationId })),
    ...bigsky.map(l => ({ group: 'BigSky' as const, linkId: l.id, name: l.commitment.itemName, quantity: l.quantity, targetId: l.commitmentId })),
  ];
  const plan = planPartialCancel(c.item, lines);
  if (plan.kind === 'hold') return null;
  const { line, units } = plan;
  const item = cancelledItem(c.item)!.name;
  const when = new Date(c.date ?? '');
  const note = partialNoteLine((Number.isNaN(when.getTime()) ? new Date() : when).toISOString().slice(0, 10), units, item, c.amount);
  if ((o.notes ?? '').split('\n').some(l => l.trim() === note)) return 'already';

  // Read the BFMR side before the link is cut.
  let bfmrPlan: BfmrCancelPlan | undefined;
  if (line.group === 'BFMR') {
    const reserveId = bfmr.find(l => l.id === line.linkId)?.reservation.reserveId ?? null;
    bfmrPlan = planBfmrPartial(o, reserveId, units, c.amount, await bfmrLinesFor(o.id, uid));
  }

  await prisma.$transaction(async tx => {
    const left = line.quantity - units;
    const where = { id: line.linkId, quantity: line.quantity };
    const n = line.group === 'BuyingGroup'
      ? (left > 0 ? await tx.orderCommitmentLink.updateMany({ where, data: { quantity: left } }) : await tx.orderCommitmentLink.deleteMany({ where }))
      : line.group === 'BFMR'
        ? (left > 0 ? await tx.orderBfmrLink.updateMany({ where, data: { quantity: left } }) : await tx.orderBfmrLink.deleteMany({ where }))
        : (left > 0 ? await tx.orderBigSkyLink.updateMany({ where, data: { quantity: left } }) : await tx.orderBigSkyLink.deleteMany({ where }));
    if (n.count !== 1) throw new Error('link changed under the cancel');
    const cur = await tx.order.findUnique({ where: { id: o.id }, select: { notes: true } });
    await tx.order.update({ where: { id: o.id }, data: { notes: addLine(cur?.notes, note) } });
  });

  const groupLines: string[] = [];
  if (line.group === 'BuyingGroup') {
    groupLines.push(...await bgReduceLines(uid, [{ group: 'BuyingGroup', name: line.name, quantity: units, commitmentId: line.targetId }], enabled));
  } else if (line.group === 'BFMR' && bfmrPlan) {
    if (bfmrPlan.cancel.length && !enabled) {
      groupLines.push('BFMR: would cancel the reservation (setting off)');
    } else {
      const r = await cancelOnBfmr(o.id, uid, bfmrPlan, { wholeOrder: false });
      if (r.cancelled) groupLines.push(`BFMR: cancelled ${r.cancelled} reservation${r.cancelled === 1 ? '' : 's'}`);
      if (r.left.length) groupLines.push(`BFMR: left open (${[...new Set(r.left)].join('; ')}). Cancel it there if needed`);
    }
  }
  console.log(`[email-auto-cancel] partial applied group=${line.group} units=${units} user=${uid}`);
  return { platform: c.platform, orderId: o.id, wasCost: null, released: [{ group: line.group, name: line.name, quantity: units }], partial: { units, item }, groupLines };
}

async function applyCancels(cancels: CancelEmail[], held: HeldEmail[]): Promise<{ done: string[]; filled: CancelEmail[] }> {
  const done: string[] = [];
  const filled: CancelEmail[] = [];
  const byUser = new Map<number, CancelEmail[]>();
  for (const c of cancels) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
  for (const [uid, list] of byUser) {
    const wanted = new Set(list.map(c => c.order));
    const rows = await prisma.order.findMany({
      where: { userId: uid, orderNumber: { not: null } },
      select: { id: true, orderNumber: true, cost: true, cancelled: true, locked: true, itemDescription: true, notes: true },
    });
    const byNumber = new Map<string, (typeof rows)[number]>();
    for (const o of rows) {
      const d = digitsOf(o.orderNumber);
      // Prefer the live order when a number appears twice.
      if (wanted.has(d) && (!byNumber.has(d) || byNumber.get(d)!.cancelled)) byNumber.set(d, o);
    }
    const notes: CancelNote[] = [];
    const reduceOn = cancelReduceOn((await getSetting(uid, CANCEL_REDUCE_KEY))?.value);
    for (const c of list) {
      const o = byNumber.get(c.order);
      const action = cancelAction(c, o);
      console.log(`[email-auto-cancel] platform=${c.platform} action=${action} user=${uid}`);
      try {
        // A cancelled order never got its item from an order email: take it from this one. A real description is never replaced.
        // Only for a cancel this run acts on, and never on a locked order.
        if (o && c.item && cancelFillsItem(action, o, c.item)) {
          await prisma.order.updateMany({ where: { id: o.id, OR: [{ itemDescription: null }, { itemDescription: o.itemDescription }] }, data: { itemDescription: c.item } });
        }
        if (action === 'cancel' && o) {
          // Read the BFMR side before the cancel drops the links.
          const bfmrPlan = planBfmrCancel(o, await bfmrLinesFor(o.id, uid));
          const { released } = await cancelOrder(o.id, uid, { total: c.amount });
          const bfmr = released.some(r => r.group === 'BFMR') ? await cancelOnBfmr(o.id, uid, bfmrPlan) : undefined;
          notes.push({ platform: c.platform, orderId: o.id, wasCost: o.cost, released, bfmr, groupLines: await bgReduceLines(uid, released, reduceOn) });
          done.push(c.id);
          filled.push(c);
        } else if (action === 'already-cancelled' && o) {
          const released = await releaseCancelledOrder(o.id);
          if (released.length) notes.push({ platform: c.platform, orderId: o.id, wasCost: null, released, groupLines: await bgReduceLines(uid, released, reduceOn) });
          // Keep the real total visible on an order cancelled before it was recorded.
          if (c.amount > 0 && !hasCancelledTotal(o.notes)) await prisma.order.update({ where: { id: o.id }, data: { notes: withCancelledTotal(o.notes, c.amount) } });
          done.push(c.id);
          filled.push(c);
        } else if (action === 'partial-cancel' && o && !o.locked) {
          // Stays flagged either way: the order's cost is for a person to fix.
          const res = await applyPartialCancel(o, c, uid, reduceOn);
          if (res && res !== 'already') notes.push(res);
          held.push({ id: c.id, userId: uid, platform: c.platform, kind: 'cancelled', reason: res ? 'partial-cancel-applied' : 'partial-cancel' });
        } else {
          held.push({ id: c.id, userId: uid, platform: c.platform, kind: 'cancelled', reason: action === 'cancel' || action === 'already-cancelled' ? 'no-matching-order' : action });
        }
      } catch (e) {
        // Left in the inbox; the next run tries again.
        console.error(`[email-auto-cancel] failed for user ${uid}:`, String(e).slice(0, 160));
      }
    }
    if (notes.length) await notify([uid], cancelNoteText(notes));
  }
  return { done, filled };
}

// Delay notices ("Your delivery is delayed", "Delivery estimate update"): a
// dated note on the matching order. Nothing needs a person, so no alert; a
// repeat of the same note changes nothing.
async function applyDelays(delays: DelayEmail[]): Promise<string[]> {
  const done: string[] = [];
  const byUser = new Map<number, DelayEmail[]>();
  for (const d of delays) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
  for (const [uid, list] of byUser) {
    const wanted = new Set(list.map(d => d.order));
    const rows = await prisma.order.findMany({ where: { userId: uid, orderNumber: { not: null } }, select: { id: true, orderNumber: true, notes: true, cancelled: true, locked: true } });
    const byNumber = new Map<string, (typeof rows)[number]>();
    for (const o of rows) {
      const n = digitsOf(o.orderNumber);
      if (wanted.has(n) && (!byNumber.has(n) || byNumber.get(n)!.cancelled)) byNumber.set(n, o);
    }
    for (const d of list) {
      const o = byNumber.get(d.order);
      try {
        if (o && !o.cancelled && !o.locked) {
          const next = withDelayNote(o.notes, d.date, d.estimate);
          if (next !== (o.notes ?? '').trim()) await prisma.order.update({ where: { id: o.id }, data: { notes: next } });
        }
        // A cancelled or locked order gets no delay note; either way the email is handled.
        console.log(`[email-delay] platform=${d.platform} noted=${o && !o.cancelled && !o.locked ? 1 : 0} user=${uid}`);
        done.push(d.id);
      } catch (e) {
        console.error(`[email-delay] failed for user ${uid}:`, String(e).slice(0, 160));
      }
    }
  }
  return done;
}

// BuyingGroup "Deal Expired" notices: mark the commitment expired (or cut the
// split original back to what was received). Unmatched ones wait for the next
// BuyingGroup sync, then are flagged.
async function applyBgExpiries(expiries: BgExpiryEmail[], held: HeldEmail[]): Promise<string[]> {
  const done: string[] = [];
  for (const e of expiries) {
    try {
      const ids = [e.expiredId, ...(e.originalId ? [e.originalId] : [])];
      const rows: CommitmentRow[] = await prisma.buyingGroupCommitment.findMany({
        where: { userId: e.userId, commitmentId: { in: ids } },
        select: { id: true, commitmentId: true, status: true, count: true, price: true },
      });
      const action = planCommitmentExpiry(e, rows);
      if (action.kind === 'expire') await prisma.buyingGroupCommitment.update({ where: { id: action.id }, data: { status: EXPIRED } });
      else if (action.kind === 'shrink') await prisma.buyingGroupCommitment.update({ where: { id: action.id }, data: { count: action.count, total: action.total } });
      console.log(`[email-bg-expiry] action=${action.kind} user=${e.userId}`);
      if (action.kind === 'none') held.push({ id: e.id, userId: e.userId, platform: 'BuyingGroup', kind: 'other', reason: 'no-commitment' });
      else done.push(e.id);
    } catch (err) {
      console.error(`[email-bg-expiry] failed for user ${e.userId}:`, String(err).slice(0, 160));
    }
  }
  return done;
}

// BuyingGroup "Commitment Price Change Scheduled" notices. When the commitment
// already has the new price (the commitment sync got there first), its orders
// are re-priced now. Otherwise the change is kept on the commitment and the
// user gets a heads-up of what it will do; checkDuePriceChanges asks for a
// commitment sync once it is due, and the sync does the re-pricing.
async function applyBgPriceChanges(changes: BgPriceChangeEmail[], held: HeldEmail[]): Promise<string[]> {
  const done: string[] = [];
  for (const c of changes) {
    try {
      const row = await prisma.buyingGroupCommitment.findUnique({
        where: { userId_commitmentId: { userId: c.userId, commitmentId: c.commitmentId } },
        select: { id: true, commitmentId: true, price: true, commission: true },
      });
      if (!row) {
        console.log(`[email-bg-price] action=none user=${c.userId}`);
        held.push({ id: c.id, userId: c.userId, platform: 'BuyingGroup', kind: 'other', reason: 'no-commitment' });
        continue;
      }
      const cur = { price: row.price, commission: row.commission };
      const to = termsAfter(c, cur);
      if (sameTerms(cur, to)) {
        const day = (c.effectiveAt ?? c.date).slice(0, 10);
        const results = await repriceCommitmentOrders(row.id, row.commitmentId, to, day);
        await prisma.buyingGroupCommitment.update({ where: { id: row.id }, data: { pendingPrice: null, pendingCommission: null, pendingAt: null } });
        if (worthTelling(results)) await notifyPriceChange(c.userId, row.commitmentId, null, to, c.when, results, false);
        console.log(`[email-bg-price] action=reprice user=${c.userId}`);
      } else {
        await prisma.buyingGroupCommitment.update({
          where: { id: row.id },
          data: { pendingPrice: to.price, pendingCommission: to.commission, pendingAt: new Date(c.effectiveAt ?? Date.now()) },
        });
        const results = await previewCommitmentReprice(row.id, cur, to);
        if (worthTelling(results)) await notifyPriceChange(c.userId, row.commitmentId, cur, to, c.when, results, true);
        console.log(`[email-bg-price] action=pending user=${c.userId}`);
      }
      done.push(c.id);
    } catch (err) {
      console.error(`[email-bg-price] failed for user ${c.userId}:`, String(err).slice(0, 160));
    }
  }
  return done;
}

const PRICE_SYNC_KEY = 'bg_price_change_sync_at';
const PRICE_SYNC_EVERY_MS = 60 * 60 * 1000;
/** How long after its time a scheduled change may still not show in BuyingGroup's API before it is dropped. */
const PRICE_CHANGE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

// Scheduled price changes that are due: ask for that user's commitment sync
// (at most hourly), which re-prices the orders once BuyingGroup shows the new
// price. A change BuyingGroup still doesn't show a day later is dropped, and
// the user is told the orders kept their price.
async function checkDuePriceChanges(): Promise<void> {
  const now = Date.now();
  const due = await prisma.buyingGroupCommitment.findMany({
    where: { pendingAt: { lte: new Date(now) } },
    select: { id: true, userId: true, commitmentId: true, pendingAt: true },
  });
  const byUser = new Map<number, typeof due>();
  for (const d of due) if (d.userId != null) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
  for (const [uid, rows] of byUser) {
    const stale = rows.filter(r => r.pendingAt && now - r.pendingAt.getTime() > PRICE_CHANGE_GIVE_UP_MS);
    if (stale.length) {
      await prisma.buyingGroupCommitment.updateMany({ where: { id: { in: stale.map(r => r.id) } }, data: { pendingPrice: null, pendingCommission: null, pendingAt: null } });
      console.log(`[email-bg-price] dropped=${stale.length} user=${uid}`);
      await notify([uid], `BuyingGroup still shows the old price a day after the change was due on ${stale.map(r => r.commitmentId).join(', ')}. Sale prices were left as they were: check My Commitments.`);
    }
    if (rows.length === stale.length) continue;
    const last = Date.parse((await getSetting(uid, PRICE_SYNC_KEY))?.value ?? '');
    if (Number.isFinite(last) && now - last < PRICE_SYNC_EVERY_MS) continue;
    await upsertSetting(uid, PRICE_SYNC_KEY, new Date(now).toISOString());
    await loopbackPost('/api/buyinggroup/sync-commitments', uid)
      .catch(e => console.warn(`[email-bg-price] commitment sync failed for user ${uid}:`, String(e).slice(0, 160)));
  }
}

const BACKFILL_KEY = 'email_cancelled_backfill_done';
const backfillState = { ran: false };

// One-time (per install) pass for cancelled orders from the last 7 days that
// have no item: re-read their emails from the worker's archive through the same
// parser and fill what is blank; whatever is still missing queues the per-order
// page read. The archive keeps mail 7 days, so this only helps while it can.
async function backfillCancelled(cf: CloudflareCreds): Promise<void> {
  const now = Date.now();
  await runBackfillOnce(
    backfillState,
    async () => !!(await getSetting(null, BACKFILL_KEY))?.value,
    () => backfillCancelledWork(cf, now),
    async () => { await upsertSetting(null, BACKFILL_KEY, new Date(now).toISOString()); },
  );
}

// Returns true when the archive read succeeded (so the backfill counts as done).
// One-time pass over the 7-day archive for Costco eGift delivery emails that arrived before the
// ingest shipped. Safe to repeat (the ingest is idempotent per order); marked done once the archive read worked.
const egiftBackfillState = { ran: false };
async function backfillEgiftLinks(cf: CloudflareCreds): Promise<void> {
  await runBackfillOnce(
    egiftBackfillState,
    async () => !!(await getSetting(null, EGIFT_BACKFILL_KEY))?.value,
    async () => {
      const r = await backfillEgiftFromArchive(cf, ingestEgiftEmails);
      console.log(egiftBackfillLine(r));
      return r.ok;
    },
    async () => { await upsertSetting(null, EGIFT_BACKFILL_KEY, new Date().toISOString()); },
  );
}

async function backfillCancelledWork(cf: CloudflareCreds, now: number): Promise<boolean> {
  const rows = await prisma.order.findMany({
    where: { cancelled: true, orderNumber: { not: null }, createdAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    select: { id: true, userId: true, platform: true, orderNumber: true, itemDescription: true, shippingAddress: true, cancelled: true, createdAt: true },
  });
  const targets = backfillTargets(rows, now);
  let archived = 0;
  let filled = 0;
  let queued = 0;
  let archiveOk = true;
  if (targets.length) {
    let emails: Awaited<ReturnType<typeof fetchCloudflareOrderEmails>> = [];
    try {
      emails = await fetchCloudflareOrderEmails(cf, undefined, { area: '/archive' });
    } catch (e) {
      archiveOk = false;
      console.error('[cancelled-backfill] archive read failed:', String(e).slice(0, 160));
    }
    archived = emails.length;
    for (const f of fillsFromArchive(targets, emails)) {
      const t = targets.find(x => x.id === f.orderId)!;
      // Only blanks, and only a cancelled order (cancelOrder locks it itself).
      if (f.item) await prisma.order.updateMany({ where: { id: f.orderId, cancelled: true, OR: [{ itemDescription: null }, { itemDescription: t.itemDescription }] }, data: { itemDescription: f.item } });
      if (f.address) await prisma.order.updateMany({ where: { id: f.orderId, cancelled: true, OR: [{ shippingAddress: null }, { shippingAddress: '' }] }, data: { shippingAddress: f.address } });
      filled++;
    }
    // Item, card and address the archive could not give: the page read, for the sidecar's account.
    const sidecarUser = trackingUserId();
    const mine = new Set(targets.filter(t => t.userId === sidecarUser).map(t => backfillDigits(t.orderNumber)));
    if (mine.size) {
      const before = await prisma.extensionCommand.count({ where: { type: 'SYNC_WALMART_ORDER', targetBrowser: 'sidecar', status: 'pending' } });
      await fillGaps({ inputs: [], ids: [], noTotal: 0 }, sidecarUser, mine);
      queued = Math.max(0, (await prisma.extensionCommand.count({ where: { type: 'SYNC_WALMART_ORDER', targetBrowser: 'sidecar', status: 'pending' } })) - before);
    }
  }
  console.log(backfillLine({ targets: targets.length, archived, filled, queued }));
  return archiveOk;
}

/**
 * BuyingGroup receipt emails: run the receipt sync now (at most once per
 * debounce window) and delete the emails only after it succeeded. A failed
 * sync keeps them for the next poll and alerts once per receipt. A receipt
 * whose tracking matches no order alerts once, then the email is deleted.
 * Returns the ids that are done with.
 */
async function handleBgReceipts(receipts: BgReceiptEmail[], allUserIds: number[]): Promise<string[]> {
  if (!receipts.length) return [];
  const now = Date.now();
  if (!shouldRunReceiptSync(now, lastReceiptSyncAt) || now < receiptFail.retryAt) return [];
  lastReceiptSyncAt = now;
  let summary: ReceiptSyncSummary = { failed: 1, synced: 0, failedUserIds: [] };
  try {
    summary = await runBgReceiptSync();
  } catch (e) {
    console.error('[bg-receipt-email] sync threw:', String(e).slice(0, 160));
  }
  const outcome = receiptSyncOutcome(summary);
  const ok = outcome !== 'failed';
  // One user's broken login: the others synced, so the receipts are handled; tell that user.
  const failing = dueUserFailAlerts(summary.failedUserIds, userFailAlertAt, now);
  for (const uid of failing) userFailAlertAt.set(uid, now);
  if (failing.length) await notify(failing, userSyncFailText());
  const alerted = await alertedIds();
  const newAlerts: string[] = [];
  let gaveUp = false;
  if (!ok) {
    // Back off, and after repeated failures alert and delete the emails.
    const plan = planReceiptFailure(receipts, alerted, receiptFail, now, summary.failedUserIds);
    receiptFail = plan.state;
    gaveUp = plan.giveUp;
    console.log(`[bg-receipt-email] sync failed receipts=${receipts.length} alerts=${plan.newKeys.length} giveUp=${gaveUp}`);
    for (const n of plan.notices) await notify(n.to === 'all' ? allUserIds : n.to, n.text);
    newAlerts.push(...plan.newKeys);
  } else {
    receiptFail = NO_RECEIPT_FAILURES;
    const rows = await prisma.order.findMany({ where: { trackingNumbers: { not: null } }, select: { trackingNumbers: true } });
    const none = unmatchedReceipts(receipts, rows.map(r => r.trackingNumbers ?? ''));
    const fresh = freshAlerts(none, alerted, 'nomatch');
    console.log(`[bg-receipt-email] synced receipts=${receipts.length} noMatch=${none.length} alerts=${fresh.length}`);
    if (fresh.length) await notify(allUserIds, receiptAlertText('nomatch', fresh.map(r => r.receiptId)));
    newAlerts.push(...fresh.map(r => alertKey('nomatch', r.receiptId)));
  }
  if (newAlerts.length) await upsertSetting(null, ALERTED_KEY, JSON.stringify([...alerted, ...newAlerts].slice(-ALERTED_MAX)));
  return ok || gaveUp ? receipts.map(r => r.id) : [];
}

export type AutoImportResult = { pulled: number; imported: Record<number, Record<string, number>>; held: number; removed: number };

export async function runEmailAutoImport(): Promise<AutoImportResult | null> {
  if (running) return null;
  running = true;
  try {
    const [mode, toggle] = await Promise.all([getSetting(null, INBOX_MODE_KEY), getSetting(null, AUTO_IMPORT_KEY)]);
    if (mode?.value !== 'cloudflare' || toggle?.value === 'off') return null;
    const cf = await cloudflareCreds();
    if (!cf) return null;

    // Per-order fetches that finished and left something empty: one note each, ever.
    await alertCouldNotGet();

    const emails = await fetchCloudflareOrderEmails(cf, undefined, { cache, bgReceipts: true, noise: true });
    // Not tied to this run's mail: a scheduled BuyingGroup price change comes due on its own clock.
    await checkDuePriceChanges().catch(e => console.error('[email-bg-price] due check failed:', String(e).slice(0, 160)));
    if (!emails.length) {
      // These read the 7-day archive or the DB, not this run's mail, so an empty inbox must not skip them.
      await sweepEgiftScrapes().catch(() => undefined);
      await backfillEgiftLinks(cf).catch(e => console.error('[egift-backfill] failed:', String(e).slice(0, 160)));
      await backfillCancelled(cf).catch(e => console.error('[cancelled-backfill] failed:', String(e).slice(0, 160)));
      return { pulled: 0, imported: {}, held: 0, removed: 0 };
    }

    const [users, senderRules, shippingRules, merchants] = await Promise.all([
      prisma.user.findMany({ select: { id: true } }),
      prisma.senderRule.findMany({ select: { userId: true, pattern: true } }),
      prisma.shippingRule.findMany({ select: { userId: true, pattern: true, buyerId: true } }),
      getSetting(null, MERCHANTS_KEY),
    ]);
    const userIds = users.map(u => u.id);
    const orders = await prisma.order.findMany({ where: { userId: { in: userIds }, orderNumber: { not: null } }, select: { userId: true, orderNumber: true } });
    const known = new Map<number, Set<string>>();
    for (const o of orders) {
      if (o.userId == null) continue;
      const set = known.get(o.userId) ?? new Set<string>();
      const d = digitsOf(o.orderNumber);
      if (d) set.add(d);
      known.set(o.userId, set);
    }
    // Only needed when BuyingGroup notices are in this batch.
    const commitmentOwners = new Map<string, number[]>();
    if (emails.some(e => e.bgPriceChange || e.bgExpiry)) {
      for (const c of await prisma.buyingGroupCommitment.findMany({ where: { userId: { not: null } }, select: { userId: true, commitmentId: true } })) {
        if (c.userId == null) continue;
        const owners = commitmentOwners.get(c.commitmentId) ?? [];
        if (!owners.includes(c.userId)) owners.push(c.userId);
        commitmentOwners.set(c.commitmentId, owners);
      }
    }

    const plan = planAutoImport(emails, {
      rules: senderRules,
      onlyUserId: userIds.length === 1 ? userIds[0] : null,
      knownOrders: uid => known.get(uid) ?? new Set(),
      shippingRules: uid => shippingRules.filter(s => s.userId === uid && s.buyerId != null) as { pattern: string; buyerId: number }[],
      learnedMerchants: parseLearnedMerchants(merchants?.value),
      commitmentOwners: id => commitmentOwners.get(id) ?? [],
      now: Date.now(),
    });

    const imported: AutoImportResult['imported'] = {};
    let removed = 0;
    for (const [uid, batch] of plan.users) {
      const merged = mergeEmailImportRows(batch.inputs);
      try {
        imported[uid] = merged.rows.length ? await importAs(uid, merged.rows) : {};
      } catch (e) {
        // Leave the emails in the inbox; the next run tries again.
        console.error(`[email-auto-import] import failed for user ${uid}:`, String(e).slice(0, 200));
        continue;
      }
      try {
        await deleteCloudflareMessages(cf, batch.ids);
        for (const id of batch.ids) cache.delete(id);
        removed += batch.ids.length;
      } catch (e) {
        // Imported but still in the inbox: the next run re-imports them, which
        // only verifies the same orders (the import matches by order number).
        console.error(`[email-auto-import] inbox delete failed for user ${uid}:`, String(e).slice(0, 200));
      }
      const c = imported[uid];
      console.log(`[email-auto-import] user=${uid} emails=${batch.ids.length} created=${c.imported ?? 0} updated=${c.updated ?? 0} verified=${c.verified ?? 0} skipped=${c.skipped ?? 0} noMatch=${c.skippedNoMatch ?? 0}${batch.noTotal ? ` noTotal=${batch.noTotal}` : ''}`);
      if (batch.noTotal) console.log(`[email-parse-miss] reason=ordered-without-total count=${batch.noTotal} user=${uid}`);
    }

    let filledCancels: CancelEmail[] = [];
    // Cancellations and PayPal receipts: the emails whose effect is written (or already
    // there) are removed from the inbox in one delete, the way cancels always were.
    const done: string[] = [];
    if (plan.cancels.length) {
      const res = await applyCancels(plan.cancels, plan.held).catch(e => {
        console.error('[email-auto-cancel] run failed:', String(e).slice(0, 160));
        return { done: [] as string[], filled: [] as CancelEmail[] };
      });
      done.push(...res.done);
      filledCancels = res.filled;
    }
    if (plan.payments.length) {
      done.push(...await applyPayments(prisma as unknown as PayPalDb, plan.payments, plan.held).catch(e => {
        console.error('[email-auto-paypal] run failed:', String(e).slice(0, 160));
        return [] as string[];
      }));
    }
    if (done.length) {
      try {
        await deleteCloudflareMessages(cf, done);
        for (const id of done) cache.delete(id);
        removed += done.length;
      } catch (e) {
        // Still in the inbox: the next run finds the order already cancelled / already noted.
        console.error('[email-auto-cancel] inbox delete failed:', String(e).slice(0, 160));
      }
    }
    const handled = [
      ...(plan.delays.length ? await applyDelays(plan.delays).catch(e => { console.error('[email-delay] run failed:', String(e).slice(0, 160)); return [] as string[]; }) : []),
      ...(plan.expiries.length ? await applyBgExpiries(plan.expiries, plan.held).catch(e => { console.error('[email-bg-expiry] run failed:', String(e).slice(0, 160)); return [] as string[]; }) : []),
      ...(plan.priceChanges.length ? await applyBgPriceChanges(plan.priceChanges, plan.held).catch(e => { console.error('[email-bg-price] run failed:', String(e).slice(0, 160)); return [] as string[]; }) : []),
    ];
    if (handled.length) {
      try {
        await deleteCloudflareMessages(cf, handled);
        for (const id of handled) cache.delete(id);
        removed += handled.length;
      } catch (e) {
        console.error('[email-notices] inbox delete failed:', String(e).slice(0, 160));
      }
    }
    // Mail positively known not to be an order. Apple trial codes skip the archive.
    for (const purge of [false, true]) {
      const ids = plan.noise.filter(n => n.purge === purge).map(n => n.id);
      if (!ids.length) continue;
      try {
        await deleteCloudflareMessages(cf, ids, fetch, { purge });
        for (const id of ids) cache.delete(id);
        removed += ids.length;
        console.log(`[email-noise] deleted=${ids.length} purged=${purge ? ids.length : 0}`);
      } catch (e) {
        console.error('[email-noise] inbox delete failed:', String(e).slice(0, 160));
      }
    }
    const receiptsDone = await handleBgReceipts(plan.receipts, userIds).catch(e => {
      console.error('[bg-receipt-email] failed:', String(e).slice(0, 160));
      return [] as string[];
    });
    if (receiptsDone.length) {
      try {
        await deleteCloudflareMessages(cf, receiptsDone);
        for (const id of receiptsDone) cache.delete(id);
        removed += receiptsDone.length;
      } catch (e) {
        console.error('[bg-receipt-email] inbox delete failed:', String(e).slice(0, 160));
      }
    }
    // Costco eGift delivery emails: save the link, then queue the card scrape (counts only in the log).
    await ingestEgiftEmails(emails);
    // Links saved while no recipient address was known: queue them once one is set.
    await sweepEgiftScrapes().catch(() => undefined);
    await alertHeld(plan.held, userIds);
    const sidecarUser = trackingUserId();
    const cancelledNow = new Set(filledCancels.filter(c => c.userId === sidecarUser).map(c => c.order));
    if (imported[sidecarUser] || cancelledNow.size) await fillGaps(plan.users.get(sidecarUser), sidecarUser, cancelledNow).catch(e => console.error('[gap-fill] failed:', String(e).slice(0, 160)));
    await queueEmailVisits(sidecarUser, plan.amazonVisits.filter(v => v.userId === sidecarUser)).catch(e => console.error('[amazon-visits] queue failed:', String(e).slice(0, 160)));
    await backfillEgiftLinks(cf).catch(e => console.error('[egift-backfill] failed:', String(e).slice(0, 160)));
    await backfillCancelled(cf).catch(e => console.error('[cancelled-backfill] failed:', String(e).slice(0, 160)));
    await nudgeMissingTracking(plan.shippedNoTracking, new Set(Object.keys(imported).map(Number))).catch(e => console.error('[email-auto-import] tracking nudge failed:', String(e).slice(0, 160)));
    return { pulled: emails.length, imported, held: plan.held.length, removed };
  } catch (e) {
    console.error('[email-auto-import] run failed:', String(e).slice(0, 200));
    return null;
  } finally {
    running = false;
  }
}

export function startEmailAutoImport(): void {
  // Background pull only: the Email tab's own import (app/api/email/*) is a person's click and is never gated.
  const run = gated('email-auto-import', runEmailAutoImport);
  setTimeout(() => { void run(); }, BOOT_DELAY_MS);
  setInterval(() => { void run(); }, POLL_MS);
}
