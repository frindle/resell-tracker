// BFMR deals and deal items for the app's routes. Uses the official REST v2 API
// (API key + secret, Settings) and falls back to the website session only when
// no key is saved. Results keep the website shapes (BfmrDeal / DealItem) so the
// pages don't change.
//
// REST v2 has no reservation counts (max_can_reserve / remaining_reservations)
// and no per-link stock. Items from REST carry counts_unknown: true; a link is
// in stock when its deal appears in /deals?in_stock=1.
import { getSetting } from '@/lib/db';
import * as rest from '@/lib/bfmr';
import * as web from '@/lib/bfmrWeb';
import type { BfmrCredentials, Deal } from '@/lib/bfmr';
import type { BfmrDeal } from '@/lib/bfmrWeb';
import { restDealItems, restItemToWeb, type DealItemOut, type RestItem } from '@/lib/bfmrDealItems';

export { restItemToWeb, type DealItemOut };

export class BfmrNotConfiguredError extends Error {
  constructor() { super('BFMR not configured: add your API key and secret in Settings'); }
}


export async function getBfmrRestCreds(uid: number | null): Promise<BfmrCredentials | null> {
  const [k, s] = await Promise.all([getSetting(uid, 'bfmr_api_key'), getSetting(uid, 'bfmr_api_secret')]);
  return k?.value && s?.value ? { apiKey: k.value, apiSecret: s.value } : null;
}

async function webCreds(uid: number | null): Promise<{ email: string; password: string } | null> {
  const [e, p] = await Promise.all([getSetting(uid, 'bfmr_email'), getSetting(uid, 'bfmr_password')]);
  return e?.value && p?.value ? { email: e.value, password: p.value } : null;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export function restDealToWeb(d: Deal, i = 0): BfmrDeal {
  const payout = num(d.payout_price);
  const retail = d.retail_price == null ? NaN : num(d.retail_price);
  return {
    id: Number.isFinite(num(d.deal_id)) ? num(d.deal_id) : i,
    title: d.title,
    slug: d.slug,
    value: Number.isFinite(payout) ? payout.toFixed(2) : '0.00',
    retail_type: d.retail_type,
    retail_price: Number.isFinite(retail) ? retail.toFixed(2) : null,
    above_retail_amount: Number.isFinite(payout) && Number.isFinite(retail) ? (payout - retail).toFixed(2) : null,
    is_reservation_closed: d.is_reservation_closed ? 1 : 0,
    other_retailers: 0,
    status: 'active',
  };
}

const PAGE = 50; // REST max page_size
const MAX_PAGES = 40;

async function allRestDeals(creds: BfmrCredentials, inStockOnly: boolean): Promise<Deal[]> {
  const out: Deal[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await rest.getDeals(creds, { page_size: PAGE, page_no: page, ...(inStockOnly ? { in_stock: '1' as const } : {}) });
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

const stockCache = new Map<string, { at: number; slugs: Set<string> }>();
const STOCK_TTL = 5 * 60 * 1000;

async function inStockSlugs(creds: BfmrCredentials): Promise<Set<string>> {
  const hit = stockCache.get(creds.apiKey);
  if (hit && Date.now() - hit.at < STOCK_TTL) return hit.slugs;
  const slugs = new Set((await allRestDeals(creds, true)).map(d => d.slug));
  stockCache.set(creds.apiKey, { at: Date.now(), slugs });
  return slugs;
}

export async function dealsFor(uid: number | null): Promise<BfmrDeal[]> {
  const creds = await getBfmrRestCreds(uid);
  if (creds) return (await allRestDeals(creds, false)).map(restDealToWeb);
  const w = await webCreds(uid);
  if (w) return web.getDeals(w.email, w.password, uid);
  throw new BfmrNotConfiguredError();
}

export async function dealItemsFor(uid: number | null, slug: string): Promise<{ dealTitle: string; items: DealItemOut[] }> {
  const creds = await getBfmrRestCreds(uid);
  if (creds) {
    const [deal, stock] = await Promise.all([rest.getDeal(creds, slug), inStockSlugs(creds).catch(() => new Set<string>())]);
    const inStock = stock.has(deal.slug ?? slug);
    return { dealTitle: deal.title, items: restDealItems(deal.items).map((it, i) => restItemToWeb(it, inStock, i)) };
  }
  const w = await webCreds(uid);
  if (w) return web.getDealItems(w.email, w.password, slug, uid);
  throw new BfmrNotConfiguredError();
}

// Cancel reservations by BFMR reserve_id. Returns the ids BFMR said were invalid.
export async function cancelReservationsRest(creds: BfmrCredentials, reserveIds: string[]): Promise<string[]> {
  const data = await rest.cancelReservations(creds, reserveIds);
  return (data.invalid_reservations ?? []).map(String);
}

// Raw REST items for a deal (they keep upc[] and model, which DealItemOut drops).
// REST only: the website session has no UPCs.
export async function dealRawItemsFor(creds: BfmrCredentials, slug: string): Promise<RestItem[]> {
  const deal = await rest.getDeal(creds, slug);
  return restDealItems(deal.items);
}
