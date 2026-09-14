#!/usr/bin/env python3
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/groupAddressMatch.ts'
IMPL = r'''// Pure comparator: does an order's already-locked shipping address (free text
// scraped from Amazon, e.g. "123 Main St, Reno, NV 89501") still match the NEW
// group's expected saved address after the order was moved between groups?
// Flags only -- never changes anything. `changeable` is true only for an
// unshipped order, whose Amazon address could still be corrected. No I/O.

export interface ExpectedAddress {
  line1: string;
  postalCode: string | null;
}

export interface AddressMatchResult {
  matches: boolean;
  changeable: boolean;
  reason: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function checkGroupAddressMatch(
  orderShippingAddress: string | null,
  expected: ExpectedAddress,
  opts: { shipped: boolean },
): AddressMatchResult {
  const changeable = !opts?.shipped;

  if (!orderShippingAddress || !orderShippingAddress.trim()) {
    return { matches: false, changeable, reason: 'order has no shipping address to compare' };
  }

  const haystack = norm(orderShippingAddress);
  const wantLine1 = norm(expected.line1 ?? '');
  const line1Ok = wantLine1.length > 0 && haystack.includes(wantLine1);

  let zipOk = true;
  if (expected.postalCode) {
    const wantZip = String(expected.postalCode).replace(/\D/g, '');
    zipOk = wantZip.length > 0 && haystack.replace(/\s+/g, '').includes(wantZip);
  }

  const matches = line1Ok && zipOk;
  const reason = matches
    ? "shipped-to address matches the group's expected address"
    : !line1Ok
      ? "shipped-to address does not match the group's expected street line"
      : "shipped-to address does not match the group's expected postal code";

  return { matches, changeable, reason };
}
'''
p.write_text(IMPL)
assert 'checkGroupAddressMatch' in IMPL and 'changeable' in IMPL and 'matches' in IMPL
print("refimpl applied")
