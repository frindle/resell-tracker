// A link to an order's detail page, as found in an Amazon email. Only an
// https link on an amazon.com host that points at an order-details page is
// kept; anything else (other hosts, redirectors, tracking pixels, plain http)
// is dropped and the visit URL is built from the order number instead. The
// host is rewritten to www.amazon.com, the only host the capture route and
// the extension accept.

const DETAIL_PATHS = new Set(['/gp/your-account/order-details', '/your-orders/order-details', '/gp/css/summary/edit.html']);
const ORDER_NO = /^\d{3}-\d{7}-\d{7}$/;

export function safeAmazonOrderLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (h !== 'amazon.com' && !h.endsWith('.amazon.com')) return null;
  if (!DETAIL_PATHS.has(u.pathname.replace(/\/+$/, ''))) return null;
  const id = u.searchParams.get('orderID') ?? u.searchParams.get('orderId');
  if (!id || !ORDER_NO.test(id)) return null;
  return `https://www.amazon.com${u.pathname.replace(/\/+$/, '')}?orderID=${id}`;
}

/** The first safe order-details link among these URLs, with its order number. */
export function firstSafeOrderLink(urls: readonly string[]): { url: string; orderNumber: string } | null {
  for (const raw of urls) {
    const url = safeAmazonOrderLink(raw);
    if (url) return { url, orderNumber: new URL(url).searchParams.get('orderID')! };
  }
  return null;
}
