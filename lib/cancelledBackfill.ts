import type { ParsedEmailOrder } from './emailMessage.ts';
import { isUselessDescription } from './gapFill.ts';
import { looksLikeAddress } from './orderFieldSync.ts';

// One-time backfill for orders that were cancelled before the import filled
// cancelled orders in (they kept no item). Their emails are still in the
// order-inbox worker's 7-day archive: re-read them through the same parser and
// fill what is blank. What the archive cannot give (card, or an item no email
// named) falls back to the per-order page read. Pure, no I/O.

export const BACKFILL_DAYS = 7;
export const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export type BackfillOrder = {
  id: number;
  userId: number | null;
  platform: string;
  orderNumber: string | null;
  itemDescription: string | null;
  shippingAddress: string | null;
  cancelled: boolean;
  createdAt: Date;
};

/** Cancelled orders from the last 7 days whose item is missing or only a store name. */
export function backfillTargets(orders: readonly BackfillOrder[], now: number): BackfillOrder[] {
  const since = now - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  return orders.filter(o => o.cancelled && digits(o.orderNumber) && o.createdAt.getTime() >= since && isUselessDescription(o.itemDescription));
}

export type ArchiveFill = { orderId: number; item?: string; address?: string };

// An order email names the items best; a cancellation's subject is cut short.
const KIND_RANK: Record<string, number> = { ordered: 0, shipped: 1, delivered: 1, cancelled: 2 };

/**
 * What the archived emails can fill for each target: the item (from the best
 * email that names one) and, when the order has none, the address. Nothing is
 * replaced: a target with a real item is not a target.
 */
export function fillsFromArchive(targets: readonly BackfillOrder[], emails: readonly ParsedEmailOrder[]): ArchiveFill[] {
  const fills: ArchiveFill[] = [];
  for (const t of targets) {
    const mine = emails
      .filter(e => digits(e.orderNumber) === digits(t.orderNumber) && e.kind in KIND_RANK)
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    const item = mine.find(e => !isUselessDescription(e.itemDescription))?.itemDescription;
    const address = looksLikeAddress(t.shippingAddress ?? '') ? undefined : mine.find(e => looksLikeAddress(e.shippingAddress))?.shippingAddress;
    if (item || address) fills.push({ orderId: t.id, ...(item ? { item } : {}), ...(address ? { address } : {}) });
  }
  return fills;
}

/** Count-only log line. */
export function backfillLine(counts: { targets: number; archived: number; filled: number; queued: number }): string {
  return `[cancelled-backfill] targets=${counts.targets} archiveEmails=${counts.archived} filled=${counts.filled} queued=${counts.queued}`;
}
