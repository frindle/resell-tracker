// BFMR REST deal items to the website's DealItem shape. Pure, so it can be
// tested without a database.
import type { DealItem } from './bfmrWeb.ts';

export type DealItemOut = DealItem & { counts_unknown?: boolean };

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

type RestLink = { retailer?: string; identifier_id?: string; url?: string; in_stock?: boolean };
export type RestItem = {
  id?: string; name?: string; model?: string; upc?: string[];
  retailer_links?: RestLink[];
};

/**
 * BFMR's GET /deals/{slug} returns `items` in two shapes (both seen 11-16):
 * a list of items with `retailer_links`, or one item object whose retailer
 * links sit under `items`, each with its own `in_stock`. Both become a list.
 */
export function restDealItems(raw: unknown): RestItem[] {
  if (Array.isArray(raw)) return raw as RestItem[];
  if (!raw || typeof raw !== 'object') return [];
  const one = raw as RestItem & { items?: RestLink[] };
  const { items, ...rest } = one;
  return [{ ...rest, retailer_links: one.retailer_links ?? (Array.isArray(items) ? items : []) }];
}

export function restItemToWeb(it: RestItem, inStock: boolean, i = 0): DealItemOut {
  const id = num(it.id);
  return {
    item_id: Number.isFinite(id) ? id : i,
    item_name: it.name,
    max_can_reserve: 0,
    is_reservation_closed: 0,
    remaining_reservations: 0,
    counts_unknown: true,
    links: (it.retailer_links ?? []).map(l => ({
      vendor_name: l.retailer ?? '',
      in_stock: l.in_stock ?? inStock,
      link_url: l.url ?? '',
      identifier: l.identifier_id ?? '',
    })),
  };
}

