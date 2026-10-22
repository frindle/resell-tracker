'use strict';

// Builds the body for POST /api/bfmr/web-session-seed from what the sidecar's
// BFMR page interceptor captured (window.__bfmrAuthHeaders: Authorization and
// X-XSRF-Token) plus the browser's cookies. Returns null when there is no token.
function buildSeedPayload(authHeaders, cookies) {
  if (!authHeaders || typeof authHeaders !== 'object') return null;
  const auth = authHeaders.Authorization;
  if (typeof auth !== 'string') return null;
  // Strip a leading "Bearer" scheme (any case, any surrounding whitespace).
  const token = auth.trim().replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (!token) return null;
  const rawXsrf = authHeaders['X-XSRF-Token'];
  const xsrf = typeof rawXsrf === 'string' ? rawXsrf.trim() : '';
  const parts = [];
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      if (!c || !c.name) continue;
      parts.push(c.name + '=' + (c.value == null ? '' : c.value));
    }
  }
  return { token, xsrf, cookieStr: parts.join('; ') };
}

module.exports = { buildSeedPayload };
