// Browser-safe (no node imports) half of the Costco eGift link helpers, so the
// client component can validate with the exact same rules as the server.
// lib/egiftLink.ts re-exports these and adds the node-only hashLink.

export function maskDeliveryLink(_normalized?: string): string {
  // Fixed mask: the delivery link is a secret, so the display value must not
  // reveal any part of the login token (not even a prefix).
  return 'Costco eGift •••';
}

export function parseCostcoDeliveryLink(
  raw: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'protocol-not-https' };
  if (url.hostname !== 'www.memberedelivery.com') return { ok: false, error: 'host-mismatch' };
  if (url.username || url.password) return { ok: false, error: 'host-mismatch' };
  const login = url.searchParams.get('login');
  if (!login) return { ok: false, error: 'missing-login' };
  return { ok: true, normalized: url.toString() };
}
