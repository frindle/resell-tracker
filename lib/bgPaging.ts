// Page through a BuyingGroup list endpoint. Pure (no imports), unit tested.
//
// Since ~2026-09-24 BG ignores the requested page_size and returns 25 rows a
// page. Every caller stopped on "short page" (fewer rows than it asked for),
// so receipts, orders and payments each saw only their newest 25 rows and BG
// payment state stopped updating for everything older (orders 665/154/761
// class). Never infer the end from the row count: stop when BG's own `pages`
// total is reached, a page is empty, or a page adds no unseen row (guards
// against an endpoint that ignores `page` and repeats page 1).
export async function bgPageAll<T>(
  fetchPage: (page: number) => Promise<unknown>,
  listKey: string,
  idOf: (row: T) => string,
  maxPages = 200,
): Promise<T[]> {
  const byId = new Map<string, T>();
  for (let page = 1; page <= maxPages; page++) {
    const data = (await fetchPage(page)) as Record<string, unknown> | unknown[] | null;
    const d = (data && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(data) ? data : (payload[listKey] ?? d.results ?? d.data ?? []);
    const items = (Array.isArray(raw) ? raw : []) as T[];
    const before = byId.size;
    for (const row of items) byId.set(idOf(row), row);
    if (items.length === 0 || byId.size === before) break;
    const pages = typeof payload.pages === 'number' ? payload.pages : null;
    if (pages != null && page >= pages) break;
  }
  return [...byId.values()];
}
