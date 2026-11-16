import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import { cloudflareCreds, INBOX_MODE_KEY } from '@/lib/emailCreds';
import { fetchCloudflareOrderEmails, deleteCloudflareMessages, type ParsedCache } from '@/lib/emailCloudflare';
import { mergeEmailImportRows } from '@/lib/emailParse';
import { planAutoImport, parseMissLine, heldSummary, needsAttention, digitsOf, trackingNudgeText, cancelAction, cancelNoteText, type HeldEmail, type ShippedNoTracking, type UserBatch, type CancelEmail, type CancelNote } from '@/lib/emailAutoImportPlan';
import { cancelOrder, releaseCancelledOrder } from '@/lib/orderCancel';
import { planBfmrCancel, type BfmrLine, type BfmrCancelPlan } from '@/lib/bfmrCancelPlan';
import { getBfmrRestCreds, cancelReservationsRest } from '@/lib/bfmrDeals';
import { MERCHANTS_KEY, parseLearnedMerchants } from '@/lib/merchants';
import { queueAmazonTracking } from '@/lib/amazonTrackingQueue';
import { trackingUserId } from '@/lib/amazonTracking';
import { planGapFill, gapFillLine, type GapOrder } from '@/lib/gapFill';
import { kickSidecarPoll } from '@/lib/sidecarKick';

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
      const q = await queueAmazonTracking(uid, amazon.map(x => fullNumber.get(x.order)!)).catch(e => {
        console.error('[email-auto-import] tracking queue failed:', String(e).slice(0, 160));
        return null;
      });
      // Queued now or already waiting in the queue: no note for those.
      if (q) still = still.filter(x => x.platform !== 'Amazon');
    }
    if (still.length) await notify([uid], trackingNudgeText(still));
  }
}

// Orders just imported for the sidecar's account that are still missing an
// item, address or tracking number queue the store's sidecar sync now rather
// than at the next scheduled one (lib/gapFill.ts). The sidecar is signed in
// to one account, so other users' orders are left to the email and the
// AI backup parser.
async function fillGaps(batch: UserBatch | undefined, uid: number): Promise<void> {
  if (!batch?.inputs.length) return;
  const wanted = new Set(batch.inputs.map(i => digitsOf(i.orderNumber)).filter(Boolean));
  const shipped = new Set(batch.inputs.filter(i => i.kind !== 'ordered').map(i => digitsOf(i.orderNumber)));
  const rows = await prisma.order.findMany({
    where: { userId: uid, cancelled: false, orderNumber: { not: null }, platform: { in: ['Walmart', 'Costco', 'Amazon'] } },
    select: { platform: true, orderNumber: true, itemDescription: true, shippingAddress: true, trackingNumbers: true },
    orderBy: { id: 'desc' },
    take: 500,
  });
  const orders: GapOrder[] = rows
    .filter(o => wanted.has(digitsOf(o.orderNumber)))
    .map(o => ({ ...o, platform: String(o.platform ?? ''), orderNumber: String(o.orderNumber ?? ''), shipped: shipped.has(digitsOf(o.orderNumber)) }));
  const plan = planGapFill(orders);
  if (!plan.syncs.length && !plan.amazonOrders.length) return;
  console.log(gapFillLine(orders, plan));

  for (const type of plan.syncs) {
    // A sync already waiting covers these orders. A running one may have
    // read the order list before they were placed, so it doesn't.
    const waiting = await prisma.extensionCommand.findFirst({ where: { type, targetBrowser: 'sidecar', status: 'pending' }, select: { id: true } });
    if (!waiting) await prisma.extensionCommand.create({ data: { type, targetBrowser: 'sidecar' } });
  }
  if (plan.amazonOrders.length) await queueAmazonTracking(uid, plan.amazonOrders);
  kickSidecarPoll();
}

// Cancellation emails for orders in the tracker. A whole-order cancellation
// cancels the order the way its Cancel button does and releases the group
// units it held; one that was already cancelled only has its leftover links
// released. Partial cancellations and locked orders wait for a person.
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
async function cancelOnBfmr(orderId: number, userId: number, plan: BfmrCancelPlan): Promise<{ cancelled: number; left: string[] }> {
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
          await prisma.order.update({ where: { id: orderId }, data: { bfmrStatus: 'cancelled' } });
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

async function applyCancels(cancels: CancelEmail[], held: HeldEmail[]): Promise<string[]> {
  const done: string[] = [];
  const byUser = new Map<number, CancelEmail[]>();
  for (const c of cancels) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
  for (const [uid, list] of byUser) {
    const wanted = new Set(list.map(c => c.order));
    const rows = await prisma.order.findMany({
      where: { userId: uid, orderNumber: { not: null } },
      select: { id: true, orderNumber: true, cost: true, cancelled: true, locked: true },
    });
    const byNumber = new Map<string, (typeof rows)[number]>();
    for (const o of rows) {
      const d = digitsOf(o.orderNumber);
      // Prefer the live order when a number appears twice.
      if (wanted.has(d) && (!byNumber.has(d) || byNumber.get(d)!.cancelled)) byNumber.set(d, o);
    }
    const notes: CancelNote[] = [];
    for (const c of list) {
      const o = byNumber.get(c.order);
      const action = cancelAction(c, o);
      console.log(`[email-auto-cancel] platform=${c.platform} action=${action} user=${uid}`);
      try {
        if (action === 'cancel' && o) {
          // Read the BFMR side before the cancel drops the links.
          const bfmrPlan = planBfmrCancel(o, await bfmrLinesFor(o.id, uid));
          const { released } = await cancelOrder(o.id, uid);
          const bfmr = released.some(r => r.group === 'BFMR') ? await cancelOnBfmr(o.id, uid, bfmrPlan) : undefined;
          notes.push({ platform: c.platform, orderId: o.id, wasCost: o.cost, released, bfmr });
          done.push(c.id);
        } else if (action === 'already-cancelled' && o) {
          const released = await releaseCancelledOrder(o.id);
          if (released.length) notes.push({ platform: c.platform, orderId: o.id, wasCost: null, released });
          done.push(c.id);
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
  return done;
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

    const emails = await fetchCloudflareOrderEmails(cf, undefined, { cache });
    if (!emails.length) return { pulled: 0, imported: {}, held: 0, removed: 0 };

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

    const plan = planAutoImport(emails, {
      rules: senderRules,
      onlyUserId: userIds.length === 1 ? userIds[0] : null,
      knownOrders: uid => known.get(uid) ?? new Set(),
      shippingRules: uid => shippingRules.filter(s => s.userId === uid && s.buyerId != null) as { pattern: string; buyerId: number }[],
      learnedMerchants: parseLearnedMerchants(merchants?.value),
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

    if (plan.cancels.length) {
      const done = await applyCancels(plan.cancels, plan.held).catch(e => {
        console.error('[email-auto-cancel] run failed:', String(e).slice(0, 160));
        return [] as string[];
      });
      if (done.length) {
        try {
          await deleteCloudflareMessages(cf, done);
          for (const id of done) cache.delete(id);
          removed += done.length;
        } catch (e) {
          // Still in the inbox: the next run finds the order already cancelled.
          console.error('[email-auto-cancel] inbox delete failed:', String(e).slice(0, 160));
        }
      }
    }
    await alertHeld(plan.held, userIds);
    const sidecarUser = trackingUserId();
    if (imported[sidecarUser]) await fillGaps(plan.users.get(sidecarUser), sidecarUser).catch(e => console.error('[gap-fill] failed:', String(e).slice(0, 160)));
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
  setTimeout(() => { void runEmailAutoImport(); }, BOOT_DELAY_MS);
  setInterval(() => { void runEmailAutoImport(); }, POLL_MS);
}
