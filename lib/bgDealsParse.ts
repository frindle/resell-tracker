// BuyingGroup's deal list (POST /v1/deal/get_deals, multipart form). It
// replaced GET /deal/get_deals_new, which started returning 404 by 11-16.
// Pure, so it can be tested without the network.

export type BgDealsQuery = {
  page?: number;
  pageSize?: number;
  dataType?: 'on_sale_now' | 'below_cost' | 'all' | 'active';
  title?: string;
};

/** Form fields the web app sends for its deal list (mode "page"). */
export function bgDealsForm(q: BgDealsQuery = {}): Record<string, string> {
  const { page = 1, pageSize = 60, dataType = 'active', title = '' } = q;
  return {
    mode: 'page',
    page_num: String(page),
    page_size: String(pageSize),
    data_type: dataType,
    buyer_view: 'true',
    title: title.trim(),
  };
}

/** Deals and total count; the list moved from payload.deals to payload.items. */
export function parseBgDeals<T = Record<string, unknown>>(raw: unknown): { results: T[]; count: number } {
  const top = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const payload = (top.payload && typeof top.payload === 'object' ? top.payload : top) as Record<string, unknown>;
  const list = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.deals) ? payload.deals : [];
  const pg = (payload.pagination && typeof payload.pagination === 'object' ? payload.pagination : {}) as Record<string, unknown>;
  const count = typeof pg.total_items === 'number' ? pg.total_items
    : typeof payload.deals_count === 'number' ? payload.deals_count
    : typeof payload.count === 'number' ? payload.count
    : list.length;
  return { results: list as T[], count };
}
