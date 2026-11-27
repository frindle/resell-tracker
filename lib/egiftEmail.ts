// The email address a Costco eGift order's cards were sent to. The delivery
// site asks for it before it opens the order. It is personal data: only a mask
// ever reaches the browser, and nothing here logs it. No node imports, so the
// order page can validate with the same rules as the server.

export const EGIFT_DEFAULT_EMAIL_KEY = 'egift_default_email';
/** Read-only key GET /api/settings adds: the default address as a mask. */
export const EGIFT_DEFAULT_EMAIL_MASKED_KEY = 'egift_default_email_masked';

/** Trimmed address with only the domain lower-cased (a local part can be case-sensitive), or null. */
export function normalizeEgiftEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < 3 || v.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  const at = v.lastIndexOf('@');
  return v.slice(0, at + 1) + v.slice(at + 1).toLowerCase();
}

/** "a***@host" for display: enough to tell addresses apart, not to read one. */
export function maskEgiftEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** The order's own address wins; the user's default is the fallback. */
export function pickEgiftEmail(
  orderEmail: string | null | undefined,
  defaultEmail: string | null | undefined,
): { email: string | null; source: 'order' | 'default' | null } {
  const own = normalizeEgiftEmail(orderEmail);
  if (own) return { email: own, source: 'order' };
  const fallback = normalizeEgiftEmail(defaultEmail);
  return fallback ? { email: fallback, source: 'default' } : { email: null, source: null };
}
