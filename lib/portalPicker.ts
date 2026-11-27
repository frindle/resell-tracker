// What the /go middle page shows: the PortalRate rows for a merchant (and
// category), best first. Pure (no imports), unit tested.

export type PortalRateRow = {
  id: number;
  merchant: string;
  category: string | null;
  portal: string;
  rate: string;
  clickUrl?: string | null;
};

export type PortalOption = {
  merchant: string;       // this row's own spelling, which the click-url PUT matches exactly
  portal: string;
  rate: string;
  category: string;
  excluded: boolean;
  isPoints: boolean;
  value: string | null;   // "$4.50" or "1,200 pts" when the deal value is known
  clickUrl: string | null;
};

export const POINTS_PORTALS = new Set(['rakuten']);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Dollar (or point) value of a rate on a deal; null when the rate is not a number or the value unknown. */
export function rateValue(portal: string, rate: string, dealValue: number | null): string | null {
  const n = parseFloat(rate.replace('%', ''));
  if (isNaN(n) || dealValue === null || !Number.isFinite(dealValue)) return null;
  if (POINTS_PORTALS.has(portal.toLowerCase())) return `${Math.round(dealValue * n).toLocaleString('en-US')} pts`;
  return `$${(dealValue * n / 100).toFixed(2)}`;
}

/** The merchant name used in PortalRate rows for a retailer host, or null. The host's second-level label must equal the name after dropping case and punctuation. */
export function merchantForHost(host: string | null, merchants: readonly string[]): string | null {
  if (!host) return null;
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length < 2) return null;
  // second-level label, allowing co.uk style suffixes
  const label = parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2
    ? parts[parts.length - 3] : parts[parts.length - 2];
  const l = norm(label);
  if (!l) return null;
  // Exact label only: "bestbuy-deals.example" is not Best Buy.
  return merchants.find(m => norm(m) === l) ?? null;
}

export function portalOptions(rates: readonly PortalRateRow[], opts: {
  merchant: string;
  category?: string | null;
  ignored?: readonly string[];
  dealValue?: number | null;
}): PortalOption[] {
  const m = norm(opts.merchant);
  const cat = norm(opts.category ?? '');
  const ignored = new Set((opts.ignored ?? []).map(p => p.toLowerCase()));
  const dealValue = opts.dealValue ?? null;
  if (!m) return [];

  const forMerchant = rates.filter(r => norm(r.merchant) === m && !ignored.has(r.portal.toLowerCase()));
  // A portal's store page is the same for every category of a merchant.
  const linkOf = (portal: string) => forMerchant.find(r => r.portal.toLowerCase() === portal.toLowerCase() && r.clickUrl)?.clickUrl ?? null;

  // Per portal: a row for this category beats the all-categories row.
  const byPortal = new Map<string, PortalRateRow>();
  for (const r of forMerchant) {
    const rc = norm(r.category ?? '');
    if (rc && rc !== cat) continue;
    const key = r.portal.toLowerCase();
    const cur = byPortal.get(key);
    if (!cur || (rc && !norm(cur.category ?? ''))) byPortal.set(key, r);
  }

  const out: PortalOption[] = [...byPortal.values()].map(r => ({
    merchant: r.merchant,
    portal: r.portal,
    rate: r.rate,
    category: r.category ?? '',
    excluded: r.rate.trim().toLowerCase() === 'excluded',
    isPoints: POINTS_PORTALS.has(r.portal.toLowerCase()),
    value: rateValue(r.portal, r.rate, dealValue),
    clickUrl: linkOf(r.portal),
  }));

  const num = (o: PortalOption) => parseFloat(o.rate) || 0;
  const tier = (o: PortalOption) => (o.excluded ? 2 : o.isPoints ? 1 : 0);
  return out.sort((a, b) => tier(a) - tier(b) || num(b) - num(a) || a.portal.localeCompare(b.portal));
}

/** A portal store link: http(s) only. Empty text clears it. Null when invalid. */
export function parseClickUrl(raw: unknown): string | '' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

/** Query string for the /go page; the extension sends only `url` and `src`. */
export function goHref(o: { url: string; src?: string; merchant?: string; category?: string; value?: number | string | null }): string {
  const q = new URLSearchParams({ url: o.url });
  if (o.src) q.set('src', o.src);
  if (o.merchant) q.set('merchant', o.merchant);
  if (o.category) q.set('category', o.category);
  if (o.value != null && o.value !== '' && Number.isFinite(Number(o.value))) q.set('value', String(Number(o.value)));
  return `/go?${q.toString()}`;
}

/** Body for the click-url PUT: the option's own merchant spelling, since the server matches it exactly. */
export function clickUrlBody(o: Pick<PortalOption, 'merchant' | 'portal'>, clickUrl: string): { merchant: string; portal: string; clickUrl: string } {
  return { merchant: o.merchant, portal: o.portal, clickUrl };
}
