// Backfill: sends photos for cards that were submitted to CardCenter BEFORE
// photo sending existed. Step 1 links past photo-OCR'd gift-card photos to their
// card (only PhotoOcr.kind === 'gift_card': receipts and unknown photos carry
// personal details and are never linked or sent). Step 2 sends them, one
// reservation at a time. Idempotent through GiftCard.ccImagesSentAt.
// Card codes appear only as last 4 in logs.
import { normalizeCode } from './giftCardOcrVerify.ts';
import { sendCardImages, type ImageCard, type ImageDeps } from './cardcenterImages.ts';

export const BACKFILL_MAX_RESERVATIONS = 25;
export const BACKFILL_GAP_MS = 2000;

export type UnlinkedPhoto = {
  attachmentId: number;
  orderId: number;
  kind: string | null;
  ocrGiftCardId: number | null;
  candidates: string[];
  texts: string[];
};
export type OrderCard = { id: number; orderId: number; cardNumber: string };

export interface BackfillDeps extends ImageDeps {
  /** Photos with no giftCardId yet that have a PhotoOcr row, on this user's orders. */
  listUnlinkedPhotos(userId: number | null): Promise<UnlinkedPhoto[]>;
  listOrderCards(orderIds: number[]): Promise<OrderCard[]>;
  linkPhoto(attachmentId: number, giftCardId: number): Promise<void>;
  /** Submitted cards with a reservation and no ccImagesSentAt, with their linked photos. */
  listBackfillCards(userId: number | null): Promise<ImageCard[]>;
  sleep(ms: number): Promise<void>;
}

export type LinkPlan = { links: { attachmentId: number; cardId: number }[]; ambiguous: number };

export function planLinks(photos: UnlinkedPhoto[], cards: OrderCard[]): LinkPlan {
  const plan: LinkPlan = { links: [], ambiguous: 0 };
  for (const p of photos) {
    if (p.kind !== 'gift_card') continue; // receipts / unknown: never
    const onOrder = cards.filter(c => c.orderId === p.orderId);
    const direct = p.ocrGiftCardId != null ? onOrder.find(c => c.id === p.ocrGiftCardId) : undefined;
    if (direct) { plan.links.push({ attachmentId: p.attachmentId, cardId: direct.id }); continue; }

    const norm = onOrder.map(c => ({ c, n: normalizeCode(c.cardNumber) })).filter(x => x.n.length >= 8);
    const candSet = new Set(p.candidates.map(normalizeCode));
    let matches = norm.filter(x => candSet.has(x.n));
    if (!matches.length) {
      const joined = normalizeCode(p.texts.join(''));
      matches = norm.filter(x => joined.includes(x.n));
    }
    if (matches.length === 1) plan.links.push({ attachmentId: p.attachmentId, cardId: matches[0].c.id });
    else plan.ambiguous++; // none or several
  }
  return plan;
}

export type BackfillResult = {
  dryRun: boolean;
  reservations: number;
  cards: number;
  photos: number;
  ambiguous: number;
  noPhoto: number;
  linked: number;
  sentCards?: number;
  failedCards?: number;
  remainingReservations?: number;
  error?: string;
};

let running = false;

export async function backfillCardImages(
  userId: number | null,
  opts: { dryRun?: boolean },
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const dryRun = opts.dryRun === true;
  const out: BackfillResult = { dryRun, reservations: 0, cards: 0, photos: 0, ambiguous: 0, noPhoto: 0, linked: 0 };

  const unlinked = await deps.listUnlinkedPhotos(userId);
  const orderIds = [...new Set(unlinked.filter(p => p.kind === 'gift_card').map(p => p.orderId))];
  const plan = planLinks(unlinked, orderIds.length ? await deps.listOrderCards(orderIds) : []);
  out.ambiguous = plan.ambiguous;
  out.linked = plan.links.length;
  if (!dryRun) for (const l of plan.links) await deps.linkPhoto(l.attachmentId, l.cardId);

  const cards = await deps.listBackfillCards(userId);
  const extra = new Map<number, number>(); // dry-run only: photos that would be linked
  if (dryRun) for (const l of plan.links) extra.set(l.cardId, (extra.get(l.cardId) ?? 0) + 1);

  const groups = new Map<number, ImageCard[]>();
  for (const c of cards) {
    const n = c.photos.length + (extra.get(c.id) ?? 0);
    if (!n || !c.ccReservationId) { if (!n) out.noPhoto++; continue; }
    out.cards++;
    out.photos += n;
    const g = groups.get(c.ccReservationId) ?? [];
    g.push(c);
    groups.set(c.ccReservationId, g);
  }
  out.reservations = groups.size;
  if (dryRun) return out;

  const email = (await deps.getSetting(userId, 'cc_email'))?.value;
  const password = (await deps.getSetting(userId, 'cc_password'))?.value;
  if (!email || !password) { out.error = 'CardCenter credentials not configured'; return out; }
  const auth = { userId, email, password };

  const ids = [...groups.keys()].sort((a, b) => a - b);
  const batch = ids.slice(0, BACKFILL_MAX_RESERVATIONS);
  out.remainingReservations = ids.length - batch.length;
  out.sentCards = 0;
  out.failedCards = 0;
  for (let i = 0; i < batch.length; i++) {
    if (i) await deps.sleep(BACKFILL_GAP_MS);
    try {
      const r = await sendCardImages(auth, batch[i], groups.get(batch[i])!, {}, deps);
      out.sentCards += r.sent.length;
      out.failedCards += r.failed.length;
    } catch (e) {
      out.failedCards += groups.get(batch[i])!.length;
      console.warn(`[cardcenter-images] backfill reservation ${batch[i]} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
  return out;
}

/** Guarded so a manual run and the scheduled tick never overlap. */
export async function runBackfillGuarded(userId: number | null, opts: { dryRun?: boolean }, deps?: BackfillDeps): Promise<BackfillResult | { busy: true }> {
  if (running && !opts.dryRun) return { busy: true };
  const d = deps ?? (await import('./cardcenterImagesDeps.ts')).backfillDeps;
  if (!opts.dryRun) running = true;
  try { return await backfillCardImages(userId, opts, d); } finally { if (!opts.dryRun) running = false; }
}

const RUN_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 20 * 60 * 1000;

/** Hourly, for users with CardCenter credentials and cc_send_images not 'false'. */
export async function backfillAllUsers(): Promise<void> {
  const d = (await import('./cardcenterImagesDeps.ts'));
  let users: number[];
  try { users = await d.usersWithCardCenter(); } catch { return; }
  for (const uid of users) {
    try {
      const setting = await d.backfillDeps.getSetting(uid, 'cc_send_images');
      if (setting?.value === 'false') continue;
      await runBackfillGuarded(uid, {}, d.backfillDeps);
    } catch (e) {
      console.error(`[cardcenter-images] backfill user ${uid} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

export function startImageBackfill(): void {
  const tick = () => { void backfillAllUsers(); };
  setTimeout(() => { tick(); setInterval(tick, RUN_MS); }, BOOT_DELAY_MS);
}
