import { routeEmail, type EmailKind, type EmailRowInput, type RouteRule } from './emailParse.ts';
import type { ParsedEmailOrder } from './emailMessage.ts';
import { matchShippingRule } from './shippingRuleMatch.ts';
import type { BgReceiptEmail } from './bgReceiptEmail.ts';
import type { BgExpiry } from './emailNoise.ts';
import { isUselessDescription } from './gapFill.ts';
import { resolveMerchant, type LearnedMerchant } from './merchants.ts';
import type { PayPalReceipt } from './paypalReceipt.ts';

// What the automatic inbox import does with each email, decided without
// touching the database or the inbox so it can be tested on its own.
//
// It imports exactly what a person would get by pressing Import on the
// Email tab with the default picks: ordered, shipped and delivered emails
// that carry an order number and belong to one user. Everything else stays
// in the inbox for a person to look at.

export type HoldReason =
  | 'unassigned'        // no user's Email Routing address matches
  | 'ambiguous'         // more than one user's address matches
  | 'needs-review'      // refund or other kind: a person decides
  | 'no-commitment'     // a BuyingGroup notice for a commitment the tracker doesn't have
  | 'partial-cancel'    // a cancellation that doesn't cover the whole order
  | 'locked-order'      // a cancellation for an order someone locked
  | 'new-store'         // a sender the tracker doesn't know yet (see lib/merchants.ts)
  | 'no-order-number'   // the parser found no order number
  | 'waiting-for-order' // shipping/delivery note whose order is not in the tracker yet
  | 'no-matching-order'; // still no order for it after WAIT_FOR_ORDER_MS

export type HeldEmail = { id: string; userId: number | null; platform: string; kind: EmailKind; reason: HoldReason };

export type UserBatch = { inputs: EmailRowInput[]; ids: string[]; noTotal: number };

/** A shipping or delivery email with no tracking number in it, for an order that is being imported. */
export type ShippedNoTracking = { id: string; userId: number; platform: string; order: string };

/** A cancellation email for an order the user has (or that this run imports). */
export type CancelEmail = { id: string; userId: number; platform: string; order: string; amount: number; whole: boolean; /** Item name(s) the email gives, to fill an order that has none. */ item?: string };

/** An Amazon ORDER or SHIPPED email that was imported: the order it names and a safe link to its page, if the email had one. */
export type AmazonVisitHint = { userId: number; order: string; kind: 'ordered' | 'shipped'; link?: string };

/** A PayPal receipt to link to one of the user's orders (lib/paypalMatch.ts). `date` is the email's date. */
export type PaymentEmail = { id: string; userId: number; receipt: PayPalReceipt; date: string };

/** A delay notice for an order the user has (or that this run imports). `estimate` is '' when the email gives none. */
export type DelayEmail = { id: string; userId: number; platform: string; order: string; estimate: string; date: string };

/** A BuyingGroup deal-expired notice for a user's commitment. */
export type BgExpiryEmail = { id: string; userId: number } & BgExpiry;

/** A message positively known not to be an order. `purge` skips the 7-day archive. */
export type NoiseEmail = { id: string; purge: boolean };

export type AutoImportPlan = {
  users: Map<number, UserBatch>; held: HeldEmail[]; shippedNoTracking: ShippedNoTracking[]; cancels: CancelEmail[];
  /** Amazon order and shipping emails, for the targeted visit queue (lib/amazonVisitQueue.ts). */
  amazonVisits: AmazonVisitHint[];
  /** BuyingGroup receipt emails: they trigger the receipt sync, they are never imported. */
  receipts: BgReceiptEmail[];
  delays: DelayEmail[];
  expiries: BgExpiryEmail[];
  /** Not orders (promos, sign-in alerts, surveys, notices): deleted from the inbox. */
  noise: NoiseEmail[];
  /** PayPal receipts: linked to an order afterwards (paypalMatch), never imported. */
  payments: PaymentEmail[];
};

export type PlanContext = {
  rules: readonly RouteRule[];
  onlyUserId: number | null;
  /** Normalized (digits only) order numbers each user already has. */
  knownOrders: (userId: number) => ReadonlySet<string>;
  /** Shipping-address rules for a user, to pre-fill the buyer like the Email tab does. */
  shippingRules: (userId: number) => readonly { pattern: string; buyerId: number }[];
  /** Stores a person confirmed on the Email tab. */
  learnedMerchants?: readonly LearnedMerchant[];
  now: number;
};

const IMPORT_KINDS: ReadonlySet<EmailKind> = new Set(['ordered', 'shipped', 'delivered', 'cancelled']);

/** A shipping note that arrives before its order email waits this long before it is flagged. */
export const WAIT_FOR_ORDER_MS = 2 * 24 * 60 * 60 * 1000;

export const digitsOf = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Reasons worth telling a person about. A short wait for the order email is not one. */
export function needsAttention(reason: HoldReason): boolean {
  return reason !== 'waiting-for-order';
}

export function planAutoImport(emails: readonly ParsedEmailOrder[], ctx: PlanContext): AutoImportPlan {
  const users = new Map<number, UserBatch>();
  const held: HeldEmail[] = [];
  const shippedNoTracking: ShippedNoTracking[] = [];
  const cancels: CancelEmail[] = [];
  const amazonVisits: AmazonVisitHint[] = [];
  const receipts: BgReceiptEmail[] = [];
  const payments: PaymentEmail[] = [];
  const delays: DelayEmail[] = [];
  const expiries: BgExpiryEmail[] = [];
  const noise: NoiseEmail[] = [];
  const candidates: { email: ParsedEmailOrder; userId: number; platform: string }[] = [];

  for (const email of emails) {
    const id = String(email.uid);
    if (email.bgReceipt) {
      receipts.push({ id, receiptId: email.bgReceipt.receiptId, trackingNumbers: email.bgReceipt.trackingNumbers });
      continue;
    }
    // Known not-an-order mail needs no user: it is deleted whoever it was for.
    if (email.noise) {
      noise.push({ id, purge: email.noise.purge });
      continue;
    }
    const r = routeEmail(ctx.rules, email, { onlyUserId: ctx.onlyUserId });
    if (r.userId == null) {
      held.push({ id, userId: null, platform: email.platform, kind: email.kind, reason: r.via === 'ambiguous' ? 'ambiguous' : 'unassigned' });
      continue;
    }
    if (email.bgExpiry) {
      expiries.push({ id, userId: r.userId, ...email.bgExpiry });
      continue;
    }
    // A PayPal receipt is not an order: it is linked to one afterwards (paypalMatch).
    if (email.kind === 'payment' && email.payment) {
      payments.push({ id, userId: r.userId, receipt: email.payment, date: email.date });
      continue;
    }
    if (!IMPORT_KINDS.has(email.kind) && email.kind !== 'delayed') {
      held.push({ id, userId: r.userId, platform: email.platform, kind: email.kind, reason: 'needs-review' });
      continue;
    }
    const merchant = resolveMerchant(email.platform, email.from, ctx.learnedMerchants ?? []);
    if (!merchant.known) {
      held.push({ id, userId: r.userId, platform: email.platform, kind: email.kind, reason: 'new-store' });
      continue;
    }
    if (!digitsOf(email.orderNumber)) {
      held.push({ id, userId: r.userId, platform: email.platform, kind: email.kind, reason: 'no-order-number' });
      continue;
    }
    candidates.push({ email, userId: r.userId, platform: merchant.platform });
  }

  // A shipping or delivery note only fills in an order that exists, so one
  // that arrives before its order email (or without one) would be thrown
  // away by the import. Keep it until the order shows up.
  const orderedInBatch = new Set(candidates.filter(c => c.email.kind === 'ordered').map(c => `${c.userId}:${digitsOf(c.email.orderNumber)}`));

  for (const { email, userId, platform } of candidates) {
    const id = String(email.uid);
    const num = digitsOf(email.orderNumber);
    // An email covering several orders waits until every one of them exists.
    const parts = [{ order: num }, ...(email.kind === 'cancelled' ? [] : email.extraOrders ?? []).map(x => ({ order: digitsOf(x.orderNumber) }))];
    const unknown = (n: string) => !orderedInBatch.has(`${userId}:${n}`) && !ctx.knownOrders(userId).has(n);
    if (email.kind !== 'ordered' && parts.some(x => x.order && unknown(x.order))) {
      const age = ctx.now - new Date(email.date).getTime();
      // An undated email can't be timed, so it's flagged straight away.
      const reason: HoldReason = !Number.isFinite(age) || age > WAIT_FOR_ORDER_MS ? 'no-matching-order' : 'waiting-for-order';
      held.push({ id, userId, platform: email.platform, kind: email.kind, reason });
      continue;
    }
    if (email.kind === 'delayed') {
      delays.push({ id, userId, platform, order: num, estimate: email.delay?.estimate ?? '', date: email.date });
      continue;
    }
    if (email.kind === 'cancelled') {
      cancels.push({ id, userId, platform, order: num, amount: email.cancel?.amount ?? 0, whole: email.cancel?.whole ?? false, item: email.itemDescription });
      continue;
    }
    const buyer = matchShippingRule(email.shippingAddress, ctx.shippingRules(userId));
    const batch = users.get(userId) ?? { inputs: [], ids: [], noTotal: 0 };
    batch.inputs.push({
      kind: email.kind,
      platform,
      orderNumber: email.orderNumber.trim(),
      orderDate: email.date,
      itemDescription: email.itemDescription,
      cost: email.cost,
      shippingCost: 0,
      salePrice: null,
      buyerId: buyer ? String(buyer.buyerId) : '',
      cardId: '',
      cashbackAmount: 0,
      shippingAddress: email.shippingAddress || '',
      trackingNumbers: email.trackingNumbers,
      ...(email.merchandiseSubtotal != null ? { merchandiseSubtotal: email.merchandiseSubtotal } : {}),
    });
    batch.ids.push(id);
    if (platform === 'Amazon' && (email.kind === 'ordered' || email.kind === 'shipped')) {
      amazonVisits.push({ userId, order: email.orderNumber.trim(), kind: email.kind, ...(email.orderLink ? { link: email.orderLink } : {}) });
      for (const x of email.extraOrders ?? []) if (digitsOf(x.orderNumber) && digitsOf(x.orderNumber) !== num) amazonVisits.push({ userId, order: x.orderNumber.trim(), kind: email.kind });
    }
    if (email.kind === 'ordered' && !(email.cost > 0)) batch.noTotal++;
    if (email.kind !== 'ordered' && email.trackingNumbers.length === 0) shippedNoTracking.push({ id, userId, platform, order: num });
    // The other orders in the same email get their own items and tracking.
    for (const x of email.extraOrders ?? []) {
      const n = digitsOf(x.orderNumber);
      if (!n || n === num) continue;
      batch.inputs.push({
        kind: email.kind, platform, orderNumber: x.orderNumber.trim(), orderDate: email.date,
        itemDescription: x.itemDescription, cost: 0, shippingCost: 0, salePrice: null,
        buyerId: buyer ? String(buyer.buyerId) : '', cardId: '', cashbackAmount: 0,
        shippingAddress: email.shippingAddress || '', trackingNumbers: x.trackingNumbers,
      });
      if (x.trackingNumbers.length === 0) shippedNoTracking.push({ id, userId, platform, order: n });
    }
    users.set(userId, batch);
  }

  return { users, held, shippedNoTracking, cancels, amazonVisits, receipts, delays, expiries, noise, payments };
}

export type CancelTarget = { id: number; cost: number; cancelled: boolean; locked: boolean };
export type CancelAction = 'cancel' | 'already-cancelled' | 'partial-cancel' | 'locked-order' | 'no-matching-order';

/**
 * What a cancellation email does to its order. The whole order is cancelled
 * when the email says so, or when the amount it released covers the order's
 * total (Walmart says "Some items were canceled" even when that is all of
 * them). Anything less is left for a person.
 */
export function cancelAction(c: Pick<CancelEmail, 'amount' | 'whole'>, o: CancelTarget | undefined): CancelAction {
  if (!o) return 'no-matching-order';
  if (o.cancelled) return 'already-cancelled';
  const covers = c.whole || (c.amount > 0 && o.cost > 0 && c.amount >= o.cost - 1);
  if (!covers) return 'partial-cancel';
  return o.locked ? 'locked-order' : 'cancel';
}

/**
 * Whether a cancel email's item name fills the order's description: for a
 * cancel this run acts on or an order already cancelled, never on a live
 * locked order, and never over a real description.
 */
export function cancelFillsItem(
  action: CancelAction,
  o: { locked: boolean; itemDescription: string | null } | undefined,
  item: string | undefined,
): boolean {
  if (!o || !item || !isUselessDescription(o.itemDescription)) return false;
  // cancelOrder locks the order it cancels, so a cancelled order is filled
  // whatever its lock says; a live order must be unlocked.
  return action === 'already-cancelled' || (action === 'cancel' && !o.locked);
}

export type CancelNote = {
  platform: string;
  orderId: number;
  wasCost: number | null;
  released: readonly { group: string; name: string; quantity: number }[];
  /** BFMR reservations cancelled on BFMR, and why any others were left open. */
  bfmr?: { cancelled: number; left: readonly string[] };
};

function bfmrSuffix(n: CancelNote): string {
  if (!n.bfmr) return ' (still open on BFMR: reorder or cancel it there)';
  if (!n.bfmr.left.length) return ' (cancelled on BFMR too)';
  const why = [...new Set(n.bfmr.left)].join('; ');
  return n.bfmr.cancelled
    ? ` (${n.bfmr.cancelled} cancelled on BFMR, ${n.bfmr.left.length} left open: ${why})`
    : ` (left open on BFMR: ${why}. Cancel it there)`;
}

/** Pushover text for orders cancelled from their email. Tracker ids, not retailer order numbers. */
export function cancelNoteText(notes: readonly CancelNote[]): string {
  const lines: string[] = [];
  for (const n of notes) {
    const head = n.wasCost != null
      ? `${n.platform} cancelled order #${n.orderId} (was $${n.wasCost.toFixed(2)}): marked cancelled.`
      : `Order #${n.orderId} was already cancelled: released what it still held.`;
    lines.push(head);
    for (const r of n.released) {
      lines.push(`  Released ${r.group}: ${r.quantity}× ${r.name.length > 60 ? `${r.name.slice(0, 57)}…` : r.name}${r.group === 'BFMR' ? bfmrSuffix(n) : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * One log line per email the import could not take, with no names,
 * addresses, order numbers or item titles, so the error digest can count
 * parse misses without reading anyone's mail.
 */
export function parseMissLine(h: HeldEmail): string {
  return `[email-parse-miss] platform=${h.platform} kind=${h.kind} reason=${h.reason} user=${h.userId ?? 'none'}`;
}

const REASON_TEXT: Record<HoldReason, string> = {
  unassigned: 'no Email Routing address matches',
  ambiguous: 'more than one user matches',
  'needs-review': 'needs a person (refund or unknown kind)',
  'no-commitment': 'no matching BuyingGroup commitment',
  'partial-cancel': 'some items cancelled: adjust the order and its links',
  'locked-order': 'cancellation for a locked order: check it',
  'new-store': 'new store: import it once on the Email tab and the tracker will know it',
  'no-order-number': 'no order number found',
  'waiting-for-order': 'waiting for its order email',
  'no-matching-order': 'no matching order after 2 days',
};

/** Pushover text for emails left in the inbox. Platform, kind and reason only. */
export function heldSummary(held: readonly HeldEmail[]): string {
  const counts = new Map<string, number>();
  for (const h of held) {
    const k = `${h.platform} ${h.kind}: ${REASON_TEXT[h.reason]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const lines = [...counts].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k));
  return `${held.length} order email${held.length === 1 ? '' : 's'} need${held.length === 1 ? 's' : ''} a look in Import › Email:\n${lines.join('\n')}`;
}

/**
 * Pushover text for orders that shipped with no tracking number in the email.
 * Amazon never puts the carrier number in its emails. For the account the
 * sidecar and Brave extension use it is looked up automatically
 * (lib/amazonTracking.ts); other users' Amazon orders get this note.
 */
export function trackingNudgeText(list: readonly Pick<ShippedNoTracking, 'platform'>[]): string {
  const counts = new Map<string, number>();
  for (const x of list) counts.set(x.platform, (counts.get(x.platform) ?? 0) + 1);
  const lines: string[] = [];
  for (const [platform, n] of counts) {
    const orders = `${n} ${platform} order${n === 1 ? '' : 's'}`;
    lines.push(platform === 'Amazon'
      ? `${orders} shipped. Amazon's email has no tracking number: open the order on Amazon (Track package) and add it.`
      : `${orders} shipped, but the email had no tracking number. Check the order page.`);
  }
  return lines.join('\n');
}
