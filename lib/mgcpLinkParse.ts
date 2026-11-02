// Browser-safe parse/mask helpers for MyGiftCardsPlus card links. The link
// carries the card's access token, so it is a secret: the display mask is fixed.

export function maskMgcpLink(_normalized?: string): string {
  return 'MGCP card •••';
}

export function parseMgcpLink(
  raw: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'protocol-not-https' };
  if (url.hostname !== 'www.mygiftcardsplus.com') return { ok: false, error: 'host-mismatch' };
  if (url.username || url.password) return { ok: false, error: 'host-mismatch' };
  if (url.pathname !== '/card') return { ok: false, error: 'path-mismatch' };
  const c = url.searchParams.get('c');
  if (!c) return { ok: false, error: 'missing-token' };
  // Normalise to just the token so equivalent links dedupe.
  const out = new URL('https://www.mygiftcardsplus.com/card');
  out.searchParams.set('c', c);
  return { ok: true, normalized: out.toString() };
}

// Split pasted text (newlines/whitespace/commas) into candidate link strings.
export function splitMgcpLinks(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
