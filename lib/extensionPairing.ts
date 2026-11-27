import crypto from 'node:crypto';

// One-click pairing so the extension never needs EXTENSION_SHARED_SECRET pasted in by hand.
//   1. The extension calls POST /api/extension/pair and gets a code (goes in the approval tab's URL)
//      and a claim (stays in the extension).
//   2. It opens /extension/pair?code=... in the tracker. Someone signed in to the tracker clicks
//      Approve, which binds the pairing to their user.
//   3. The extension calls POST /api/extension/pair/claim with code + claim and, once approved, gets
//      the shared secret and its user id, one time only.
// The code alone never yields the secret, so a leaked approval URL (history, screen share) is not
// enough. Pending pairings live in memory: they last 10 minutes and a restart just means pairing again.

export const PAIR_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 20;

type Pending = {
  claimHash: Buffer;
  browser: string;
  createdAt: number;
  user: { id: number; name: string } | null;
};

export type PairStore = Map<string, Pending>;

/** One store per process. Route modules can be bundled separately, so it hangs off globalThis. */
export function pairStore(): PairStore {
  const g = globalThis as { __extensionPairStore?: PairStore };
  return (g.__extensionPairStore ??= new Map());
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const token = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');

function prune(store: PairStore, now: number): void {
  for (const [code, p] of store) if (now - p.createdAt >= PAIR_TTL_MS) store.delete(code);
}

/** Browser label shown on the approval page: chrome or firefox, nothing else from the caller. */
export function pairBrowser(raw: unknown): string {
  return raw === 'firefox' ? 'firefox' : 'chrome';
}

/** Starts a pairing. Null when too many are already waiting (someone spamming the open endpoint). */
export function startPairing(store: PairStore, browser: string, now = Date.now()): { code: string; claim: string } | null {
  prune(store, now);
  if (store.size >= MAX_PENDING) return null;
  const code = token(9);
  const claim = token(32);
  store.set(code, { claimHash: sha(claim), browser: pairBrowser(browser), createdAt: now, user: null });
  return { code, claim };
}

/** What the approval page shows; null when the code is unknown or expired. */
export function pendingPairing(store: PairStore, code: string, now = Date.now()): { browser: string; createdAt: number; approved: boolean } | null {
  prune(store, now);
  const p = store.get(code);
  return p ? { browser: p.browser, createdAt: p.createdAt, approved: p.user != null } : null;
}

/** Binds the pairing to the signed-in user. False when the code is unknown, expired, or already approved. */
export function approvePairing(store: PairStore, code: string, user: { id: number; name: string }, now = Date.now()): boolean {
  prune(store, now);
  const p = store.get(code);
  if (!p || p.user) return false;
  p.user = { id: user.id, name: user.name };
  return true;
}

export type ClaimResult =
  | { status: 'pending' }
  | { status: 'approved'; userId: number; userName: string }
  | { status: 'unknown' };

/** Checks code + claim. Once approved the pairing is consumed, so the secret is handed out once. */
export function claimPairing(store: PairStore, code: string, claim: string, now = Date.now()): ClaimResult {
  prune(store, now);
  const p = store.get(code);
  if (!p || typeof claim !== 'string' || !crypto.timingSafeEqual(p.claimHash, sha(claim))) return { status: 'unknown' };
  if (!p.user) return { status: 'pending' };
  store.delete(code);
  return { status: 'approved', userId: p.user.id, userName: p.user.name };
}

/**
 * Same-origin check for the approve call: another site must not approve with the session cookie.
 * Sec-Fetch-Site is set by the browser and pages cannot forge it, so it decides when present (a proxy
 * in front may rewrite Host); without it, Origin must match Host.
 */
export function sameOriginRequest(headers: { get(name: string): string | null }): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = headers.get('origin');
  const host = headers.get('host');
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
