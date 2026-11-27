// Turns each group's own deal rows into GroupEntry rows for lib/crossGroup.ts.
// Pure (type-only imports), unit tested.
import type { GroupEntry } from './crossGroup.ts';

const money = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String)
    : typeof v === 'string' || typeof v === 'number' ? [String(v)] : [];

export type BfmrDealLike = { slug: string; title: string; value: string };
export type BfmrItemLike = { model?: string; upc?: string[] };

/** BFMR: payout is the deal's payout_price (carried as `value`); UPCs and model come from the deal's items. */
export function bfmrEntry(deal: BfmrDealLike, items: BfmrItemLike[]): GroupEntry {
  return {
    group: 'bfmr',
    id: deal.slug,
    title: deal.title,
    payout: money(deal.value),
    upcs: items.flatMap(i => strings(i.upc)),
    models: items.flatMap(i => strings(i.model)),
    href: `/bfmr/deals?focus=${encodeURIComponent(deal.slug)}`,
  };
}

/**
 * BuyingGroup: payout is the `commission` the BG deals page shows. UPC and model
 * are read from the deal and its deal_item rows when the deal list carries them
 * (the commitment item rows call them `upc` and `item_model`).
 */
export function bgEntry(deal: Record<string, unknown>): GroupEntry | null {
  const key = typeof deal.key === 'string' ? deal.key : null;
  if (!key) return null;
  const rows = Array.isArray(deal.deal_item) ? (deal.deal_item as Record<string, unknown>[]) : [];
  const from = [deal, ...rows.filter(r => r && typeof r === 'object')];
  return {
    group: 'bg',
    id: key,
    title: String(deal.title ?? '').replace(/-/g, ' '),
    payout: money(deal.commission),
    upcs: from.flatMap(r => strings(r.upc)),
    models: from.flatMap(r => [...strings(r.item_model), ...strings(r.model)]),
    href: `/buyinggroup/deals?focus=${encodeURIComponent(key)}`,
  };
}
