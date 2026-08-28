import type { NextRequest } from 'next/server';

// Routes that accept X-Extension-User-Id as an acting-user claim (no
// session cookie) must correlate that claim to the shared extension
// secret — otherwise any LAN caller can impersonate an arbitrary userId
// just by setting the header, since the id itself proves nothing.
// proxy.ts already enforces this same secret at the middleware layer
// when EXTENSION_SHARED_SECRET is configured, but that's structural
// (CORS/routing) protection, not a guarantee every header-uid consumer
// re-checks it — so route handlers that trust the header call this too.
//
// If EXTENSION_SHARED_SECRET isn't configured, the deployment hasn't
// opted into secret-gated extension auth yet (LAN-trust model, same as
// today), so the header is trusted as-is to avoid breaking existing
// installs.
export function verifyExtensionSecret(req: NextRequest | Request): boolean {
  const required = process.env.EXTENSION_SHARED_SECRET;
  if (!required) return true;
  const provided = req.headers.get('X-Extension-Secret') ?? '';
  return provided === required;
}

// Resolves the acting userId for routes that accept either a session
// cookie or the X-Extension-User-Id header. Returns null if neither is
// present/valid, or if a header claim fails the shared-secret check.
export function resolveExtensionUserId(req: NextRequest | Request, sessionUid: number | null): number | null {
  if (sessionUid != null) return sessionUid;
  const headerUid = req.headers.get('X-Extension-User-Id');
  if (!headerUid) return null;
  if (!verifyExtensionSecret(req)) return null;
  const id = parseInt(headerUid, 10);
  return isNaN(id) ? null : id;
}
