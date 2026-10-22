// Classifies errors from BFMR web calls: is the stored session dead?
// lib/bfmrWeb.ts throws plain Errors like "BFMR profile 401"; a 401/419 from
// BFMR means the stored web session must be invalidated and re-seeded.
export function isBfmrAuthError(e: unknown): boolean {
  let msg: string;
  if (e == null) msg = '';
  else if (e instanceof Error) msg = e.message;
  else {
    try {
      msg = String(e);
    } catch {
      msg = ''; // e.g. Object.create(null) has no toString
    }
  }
  return /\bBFMR\b[^\n]*?\b(401|419)\b/.test(msg);
}
