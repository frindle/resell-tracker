/**
 * Pure normalizer for scraped retailer saved-address records (Amazon first, then
 * Walmart/Costco). Turns raw rows into deduped, normalized rows before
 * persistence: trims/collapses whitespace, drops unshippable entries (no line1),
 * defaults country to "US", and collapses duplicates by a stable dedupeKey
 * (OR-ing isDefault across the collapsed group). No I/O.
 */

export interface RawRetailerAddress {
  platform: string;
  fullName?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  isDefault?: boolean;
  externalId?: string | null;
}

export interface NormalizedAddress {
  platform: string;
  fullName?: string | null;
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country: string;
  phone?: string | null;
  isDefault: boolean;
  externalId?: string | null;
  dedupeKey: string;
}

/** Trim and collapse internal whitespace ("  123   Main  St " -> "123 Main St"). */
const clean = (v: string | null | undefined): string =>
  v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();

export function normalizeRetailerAddresses(raw: RawRetailerAddress[]): NormalizedAddress[] {
  const byKey = new Map<string, NormalizedAddress>();
  for (const r of raw) {
    const line1 = clean(r.line1);
    if (!line1) continue; // unshippable: no street address
    const platform = clean(r.platform);
    const fullName = clean(r.fullName) || null;
    const postalCode = clean(r.postalCode) || null;
    // Stable key from platform + line1 + postalCode + fullName (lowercased).
    const dedupeKey = [platform, line1, postalCode ?? '', fullName ?? ''].map((s) => s.toLowerCase()).join('|');
    const row: NormalizedAddress = {
      platform,
      fullName,
      line1,
      line2: clean(r.line2) || null,
      city: clean(r.city) || null,
      state: clean(r.state) || null,
      postalCode,
      country: (clean(r.country) || 'US').toUpperCase(),
      phone: clean(r.phone) || null,
      isDefault: r.isDefault === true,
      externalId: clean(r.externalId) || null,
      dedupeKey,
    };
    const prev = byKey.get(row.dedupeKey);
    if (prev) {
      prev.isDefault = prev.isDefault || row.isDefault; // OR across duplicates
    } else {
      byKey.set(row.dedupeKey, row);
    }
  }
  return [...byKey.values()];
}
