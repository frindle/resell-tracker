#!/usr/bin/env python3
"""Reference impl for rt-address-normalize. Overwrites the tracked stub; revert restores it."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/retailerAddressImport.ts'

IMPL = r'''// Pure normalizer for saved addresses scraped from a retailer account
// (Amazon first, then Walmart/Costco). The browser sidecar produces the raw
// RawRetailerAddress[] from the account page's DOM; this function cleans,
// drops unshippable entries, and dedupes before the rows are persisted and
// mapped to a buying group. No I/O.

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
  fullName: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  externalId: string | null;
  dedupeKey: string;
}

function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

export function normalizeRetailerAddresses(raw: RawRetailerAddress[]): NormalizedAddress[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, NormalizedAddress>();

  for (const r of raw) {
    const line1 = clean(r?.line1);
    if (!line1) continue; // unshippable without a street line

    const platform = clean(r.platform) ?? '';
    const fullName = clean(r.fullName);
    const postalCode = clean(r.postalCode);
    const country = (clean(r.country) ?? 'US').toUpperCase();

    const dedupeKey = [platform, line1, postalCode ?? '', fullName ?? '']
      .map(x => x.toLowerCase())
      .join('|');

    const existing = byKey.get(dedupeKey);
    if (existing) {
      existing.isDefault = existing.isDefault || r.isDefault === true;
      continue;
    }

    byKey.set(dedupeKey, {
      platform,
      fullName,
      line1,
      line2: clean(r.line2),
      city: clean(r.city),
      state: clean(r.state),
      postalCode,
      country,
      phone: clean(r.phone),
      isDefault: r.isDefault === true,
      externalId: clean(r.externalId),
      dedupeKey,
    });
  }

  return Array.from(byKey.values());
}
'''
p.write_text(IMPL)
assert 'normalizeRetailerAddresses' in IMPL and 'dedupeKey' in IMPL and 'isDefault' in IMPL
print("refimpl applied")
