import { matchShippingRule, type AddressRule } from './shippingRuleMatch.ts';
import { itemsMatch } from './commitmentMatch.ts';

// Decides the group (buyer) of an order that has none. Pure and unit tested;
// the database side is lib/groupFillRun.ts.
//
//   1. The ship-to address and the shipping rules (the way the group is
//      normally known).
//   2. When the address gives nothing, the item against the group deals: BFMR
//      reservations, BuyingGroup and BigSky commitments. The caller decides
//      which deals are candidates (a cancelled order also sees voided, expired
//      and cancelled ones). If the matches belong to more than one group, or
//      to none, nothing is set.
//
// It only ever answers with a group for an order that has none. A group that
// is set, or that the person cleared on purpose (buyerId in userEditedFields),
// is kept. `locked` and `cancelled` do not change the answer: the only field
// ever written is the empty group.

export type DealGroup = 'BFMR' | 'BuyingGroup' | 'BigSkyBuyers';

export type Deal = {
  group: DealGroup;
  name: string;
  /** ms when it was made. undefined = the group has no such date; null = unknown (never matched). */
  createdAt?: number | null;
};

export type GroupFillOrder = {
  buyerId: number | null;
  /** Field names the person hand-edited. */
  userEditedFields: readonly string[];
  shippingAddress: string | null;
  itemDescription: string | null;
  orderDateMs?: number | null;
};

export type GroupDecision =
  | { kind: 'set'; buyerId: number; via: 'rule' | 'item' }
  | { kind: 'keep' }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function decideGroup(
  order: GroupFillOrder,
  rules: readonly AddressRule[],
  deals: readonly Deal[],
  buyerIdFor: (group: DealGroup) => number | null,
): GroupDecision {
  if (order.buyerId != null || order.userEditedFields.includes('buyerId')) return { kind: 'keep' };

  const rule = matchShippingRule(order.shippingAddress, rules.filter(r => r.buyerId != null));
  if (rule?.buyerId != null) return { kind: 'set', buyerId: rule.buyerId, via: 'rule' };

  if (!order.itemDescription || !order.itemDescription.trim()) return { kind: 'none' };
  const groups = new Set<DealGroup>();
  for (const d of deals) {
    // A deal made after the order's day cannot be what it was bought for.
    if (d.createdAt !== undefined && !(d.createdAt != null && order.orderDateMs != null && day(order.orderDateMs) >= day(d.createdAt))) continue;
    if (itemsMatch(order.itemDescription, d.name)) groups.add(d.group);
  }
  if (groups.size > 1) return { kind: 'ambiguous' };
  if (groups.size === 0) return { kind: 'none' };
  const buyerId = buyerIdFor([...groups][0]);
  return buyerId == null ? { kind: 'none' } : { kind: 'set', buyerId, via: 'item' };
}

export type FillCounts = { scanned: number; byRule: number; byItem: number; ambiguous: number; none: number; kept: number };

export function countDecisions(decisions: readonly GroupDecision[]): FillCounts {
  const c: FillCounts = { scanned: decisions.length, byRule: 0, byItem: 0, ambiguous: 0, none: 0, kept: 0 };
  for (const d of decisions) {
    if (d.kind === 'set') d.via === 'rule' ? c.byRule++ : c.byItem++;
    else if (d.kind === 'ambiguous') c.ambiguous++;
    else if (d.kind === 'none') c.none++;
    else c.kept++;
  }
  return c;
}
