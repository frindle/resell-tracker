// Per-field user-edit tracking for order sync/import.
//
// Background (order 919): the import upsert froze shippingAddress once any
// non-null value existed, and a whole-order userEditedAt stamp set by an
// unrelated card edit made it look like the address itself was protected.
// A real Amazon ship-to change therefore never reached the DB and the buyer
// re-match + recalc never re-fired. This module makes the protection
// per-field: only fields the user actually hand-edited (recorded in
// Order.userEditedFields, a JSON array of field names) are frozen; every
// other field stays free to update from the scrape.

export function parseUserEditedFields(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    // malformed stored value — degrade to "no fields protected"
  }
  return [];
}

export function mergeUserEditedFields(existingRaw: string | null | undefined, editedKeys: string[]): string {
  const existing = parseUserEditedFields(existingRaw);
  const merged = Array.from(new Set([...existing, ...editedKeys]));
  return JSON.stringify(merged);
}

export interface ResolvedShippingAddress {
  shippingAddress: string | null;
  addressChanged: boolean; // true iff the RESOLVED value differs from what was stored — this is the signal callers use to re-trigger buyer re-match + recalc
}

export function resolveShippingAddress(
  existingAddress: string | null | undefined,
  incomingAddress: string | null | undefined,
  userEditedFieldsRaw: string | null | undefined,
): ResolvedShippingAddress {
  const stored = existingAddress ?? null;
  // The user hand-edited the address — ALWAYS keep it, regardless of scrape.
  if (parseUserEditedFields(userEditedFieldsRaw).includes('shippingAddress')) {
    return { shippingAddress: stored, addressChanged: false };
  }
  // A scrape that found nothing must never null out a stored address.
  if (!incomingAddress) {
    return { shippingAddress: stored, addressChanged: false };
  }
  // No change — no needless rewrite / no false re-trigger.
  if (incomingAddress === stored) {
    return { shippingAddress: stored, addressChanged: false };
  }
  // Not user-edited and the scrape brought a genuinely different value:
  // take it in and signal that buyer re-match + recalc should re-fire.
  return { shippingAddress: incomingAddress, addressChanged: true };
}

export interface ExistingOrderForSync {
  shippingAddress: string | null;
  buyerId: number | null;
  userEditedFields: string | null;
}

export interface IncomingSyncRow {
  shippingAddress?: string | null;
  buyerId?: string | null;
}

export interface OrderSyncFieldUpdate {
  resolvedShippingAddress: string | null;
  resolvedBuyerId: number | null;
  addressChanged: boolean;
}

export function resolveOrderSyncFields(
  existing: ExistingOrderForSync,
  row: IncomingSyncRow,
  matchBuyerId: (address: string | undefined) => number | null,
): OrderSyncFieldUpdate {
  const addressResolution = resolveShippingAddress(existing.shippingAddress, row.shippingAddress, existing.userEditedFields);
  let resolvedBuyerId: number | null;
  if (addressResolution.addressChanged && !parseUserEditedFields(existing.userEditedFields).includes('buyerId')) {
    // Real address change and the buyer wasn't hand-assigned — re-match
    // against the NEW address (the order-919 case).
    resolvedBuyerId = matchBuyerId(addressResolution.shippingAddress ?? undefined);
  } else if (existing.buyerId == null) {
    // Ordinary frozen-until-null behaviour for an unassigned buyer.
    resolvedBuyerId = row.buyerId ? parseInt(row.buyerId, 10) : matchBuyerId(row.shippingAddress ?? existing.shippingAddress ?? undefined);
  } else {
    // A user-assigned or already-resolved buyer stays put.
    resolvedBuyerId = existing.buyerId;
  }
  return { resolvedShippingAddress: addressResolution.shippingAddress, resolvedBuyerId, addressChanged: addressResolution.addressChanged };
}

export interface PrismaOrderLookupClient {
  order: {
    findUnique: (args: {
      where: { id: number; userId: number | null };
      select: { userEditedFields: true };
    }) => Promise<{ userEditedFields: string | null } | null>;
  };
}

export async function loadAndMergeUserEditedFields(
  prismaClient: PrismaOrderLookupClient,
  orderId: number,
  userId: number | null,
  editedKeys: string[],
): Promise<string> {
  const before = await prismaClient.order.findUnique({
    where: { id: orderId, userId },
    select: { userEditedFields: true },
  });
  return mergeUserEditedFields(before?.userEditedFields ?? null, editedKeys);
}

// The single source of truth for which Order fields the PATCH route accepts.
// Lives here (not inline in the route) so the patch decision below is a pure,
// testable function — the route is a thin caller. Keep in sync with the
// columns OrderForm/import actually write.
export const ORDER_PATCHABLE_FIELDS = new Set<string>([
  'salePriceSynced', 'overdueAt', 'deliveryDeadline', 'trackingNumbers',
  'trackingValues', 'notes', 'bgExpectedPayout', 'lost', 'salePrice',
  'bfmrStatus', 'cost', 'shippingCost', 'insuranceCost', 'cashbackAmount',
  'portalCashback', 'itemDescription', 'shippingAddress', 'cardId',
]);

export interface OrderPatchDecision {
  // true iff the body carries no patchable field at all — the route MUST
  // then reject with 400 and write nothing (an empty patch is never valid).
  reject: boolean;
  // The patchable field names present in the body, in body order. These are
  // exactly the fields written AND recorded as user-edited — recording only
  // these (never the whole order) is the order-919 fix.
  patchKeys: string[];
  // A lock-bypass: a patch whose ONLY field is cashbackAmount is a
  // data-forced derived-value correction (order 832) and must skip the
  // order-locked guard. Anything alongside it, or any other single field,
  // still hits the lock.
  isCashbackOnlyCorrection: boolean;
}

export function resolveOrderPatchDecision(body: Record<string, unknown>): OrderPatchDecision {
  const patchKeys = Object.keys(body).filter(k => ORDER_PATCHABLE_FIELDS.has(k));
  return {
    reject: patchKeys.length === 0,
    patchKeys,
    isCashbackOnlyCorrection: patchKeys.length === 1 && patchKeys[0] === 'cashbackAmount',
  };
}
