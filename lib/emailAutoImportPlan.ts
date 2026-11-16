import { routeEmail, type EmailKind, type EmailRowInput, type RouteRule } from './emailParse.ts';
import type { ParsedEmailOrder } from './emailMessage.ts';
import { matchShippingRule } from './shippingRuleMatch.ts';

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
  | 'needs-review'      // cancellation, refund or other kind: a person decides
  | 'no-order-number'   // the parser found no order number
  | 'waiting-for-order' // shipping/delivery note whose order is not in the tracker yet
  | 'no-matching-order'; // still no order for it after WAIT_FOR_ORDER_MS

export type HeldEmail = { id: string; userId: number | null; platform: string; kind: EmailKind; reason: HoldReason };

export type UserBatch = { inputs: EmailRowInput[]; ids: string[]; noTotal: number };

export type AutoImportPlan = { users: Map<number, UserBatch>; held: HeldEmail[] };

export type PlanContext = {
  rules: readonly RouteRule[];
  onlyUserId: number | null;
  /** Normalized (digits only) order numbers each user already has. */
  knownOrders: (userId: number) => ReadonlySet<string>;
  /** Shipping-address rules for a user, to pre-fill the buyer like the Email tab does. */
  shippingRules: (userId: number) => readonly { pattern: string; buyerId: number }[];
  now: number;
};

const IMPORT_KINDS: ReadonlySet<EmailKind> = new Set(['ordered', 'shipped', 'delivered']);

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
  const candidates: { email: ParsedEmailOrder; userId: number }[] = [];

  for (const email of emails) {
    const id = String(email.uid);
    const r = routeEmail(ctx.rules, email, { onlyUserId: ctx.onlyUserId });
    if (r.userId == null) {
      held.push({ id, userId: null, platform: email.platform, kind: email.kind, reason: r.via === 'ambiguous' ? 'ambiguous' : 'unassigned' });
      continue;
    }
    if (!IMPORT_KINDS.has(email.kind)) {
      held.push({ id, userId: r.userId, platform: email.platform, kind: email.kind, reason: 'needs-review' });
      continue;
    }
    if (!digitsOf(email.orderNumber)) {
      held.push({ id, userId: r.userId, platform: email.platform, kind: email.kind, reason: 'no-order-number' });
      continue;
    }
    candidates.push({ email, userId: r.userId });
  }

  // A shipping or delivery note only fills in an order that exists, so one
  // that arrives before its order email (or without one) would be thrown
  // away by the import. Keep it until the order shows up.
  const orderedInBatch = new Set(candidates.filter(c => c.email.kind === 'ordered').map(c => `${c.userId}:${digitsOf(c.email.orderNumber)}`));

  for (const { email, userId } of candidates) {
    const id = String(email.uid);
    const num = digitsOf(email.orderNumber);
    if (email.kind !== 'ordered' && !orderedInBatch.has(`${userId}:${num}`) && !ctx.knownOrders(userId).has(num)) {
      const age = ctx.now - new Date(email.date).getTime();
      // An undated email can't be timed, so it's flagged straight away.
      const reason: HoldReason = !Number.isFinite(age) || age > WAIT_FOR_ORDER_MS ? 'no-matching-order' : 'waiting-for-order';
      held.push({ id, userId, platform: email.platform, kind: email.kind, reason });
      continue;
    }
    const buyer = matchShippingRule(email.shippingAddress, ctx.shippingRules(userId));
    const batch = users.get(userId) ?? { inputs: [], ids: [], noTotal: 0 };
    batch.inputs.push({
      kind: email.kind,
      platform: email.platform === 'Unknown' ? 'Other' : email.platform,
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
    });
    batch.ids.push(id);
    if (email.kind === 'ordered' && !(email.cost > 0)) batch.noTotal++;
    users.set(userId, batch);
  }

  return { users, held };
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
  'needs-review': 'needs a person (cancellation, refund or unknown kind)',
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
