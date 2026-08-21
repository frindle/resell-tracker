import { getSetting, upsertSetting } from '@/lib/db';
import { loggedFetch } from '@/lib/apiCallLog';

const BASE_URL = 'https://cardcenter.cc';

// Node's fetch (undici) sends no User-Agent/Accept by default, which looks
// nothing like the browser traffic CC's WAF is used to seeing (confirmed via
// API-spy capture 2026-07-16 — same endpoints returned clean 200s from the
// browser). A missing/bot-shaped UA is a plausible reason a burst of
// server-side requests (sync-payments' list+detail loop fires dozens of
// rapid sequential fetches) gets killed at the connection level, which Node
// surfaces as the generic `TypeError: fetch failed` rather than an HTTP
// status. Every CardCenter call should go through this so it looks like a
// normal browser client.
const CC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

// Preserves error.cause (ENOTFOUND/ECONNRESET/ETIMEDOUT/etc — the actual
// reason behind Node's generic "fetch failed") in whatever gets logged.
// String(e) alone drops it, which is why past occurrences of this error
// were unresolvable from the log alone.
export function errCause(e: unknown): string {
  const cause = (e as { cause?: unknown } | undefined)?.cause;
  return cause ? `${String(e)} | cause: ${String(cause)}` : String(e);
}

// Wraps fetch for cardcenter.cc: adds browser-like headers, and retries once
// after a short backoff on a low-level network throw.
// ponytail: single retry, fixed 1s backoff — upgrade to exponential/jittered
// backoff if this endpoint keeps needing more than one retry.
export async function ccFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...CC_HEADERS, ...(init.headers as Record<string, string> | undefined) };
  try {
    return await loggedFetch({ group: 'CC', userId: null }, url, { ...init, headers });
  } catch (e) {
    console.warn(`[cardcenter] fetch failed for ${url}, retrying once: ${errCause(e)}`);
    await new Promise(r => setTimeout(r, 1000));
    return loggedFetch({ group: 'CC', userId: null }, url, { ...init, headers });
  }
}

// Detect duplicate card codes in a batch before we ship them to CC's
// ParsedCards endpoint. CC rejects the whole submission with a
// "Duplicate of <brand> entry redacted on line X" 400 when we send two
// rows with the same code — this catches it earlier with a nicer message.
// Case-insensitive compare, ignores whitespace. PIN is not part of the
// key: CC treats codes as unique regardless of PIN.
export function findDuplicateCardCodes(
  cards: Array<{ id: number; cardNumber: string }>,
): { firstIndex: number; secondIndex: number; cardIds: [number, number] } | null {
  const seen = new Map<string, { index: number; id: number }>();
  for (let i = 0; i < cards.length; i++) {
    const key = (cards[i].cardNumber ?? '').replace(/\s+/g, '').toLowerCase();
    if (!key) continue;
    const prev = seen.get(key);
    if (prev) return { firstIndex: prev.index, secondIndex: i, cardIds: [prev.id, cards[i].id] };
    seen.set(key, { index: i, id: cards[i].id });
  }
  return null;
}

// Parses JSON from a CardCenter response, throwing a readable error if it returns HTML/text.
export async function ccJson<T>(res: Response, label: string): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} returned non-JSON (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// --- Session-based auth ---
//
// CardCenter migrated off bearer-token auth (POST /Api/Tokens, now a 404)
// to cookie+CSRF session auth some time before 2026-08. Confirmed live
// against the real site:
//   1. GET /Account/Login — HTML has a hidden __RequestVerificationToken
//      input (ASP.NET Core anti-forgery) and sets a `.AspNetCore.Antiforgery.*`
//      cookie.
//   2. POST /Account/Login (form-urlencoded: Email, Password, RememberMe,
//      __RequestVerificationToken) — success 302-redirects off the login
//      page with a Set-Cookie for the real auth session; failure re-renders
//      the login page as a 200 with validation errors and no auth cookie.
//      We never observed a real success response (no live credentials in
//      this environment) so the exact auth cookie NAME is unconfirmed —
//      rather than guess it, we keep the whole Set-Cookie jar (merged by
//      name) and always send it back, same as lib/bfmrWeb.ts already does
//      for BFMR. That makes the specific cookie name irrelevant.
//   3. GET /Api/AntiforgeryTokens (with the session cookie jar) — JSON
//      { requestToken }. This is a second, separate anti-forgery token
//      used on every /Api/* call, paired with the antiforgery cookie set
//      on *this* response (also merged into the jar).
//   4. Every /Api/* call needs: the cookie jar, header
//      `RequestVerificationToken: <step 3 token>`, and
//      `Content-Type: application/json` for bodies.
// Confirmed live: unauthenticated /Api/* returns 401 with a `Location`
// header pointing back to /Account/Login — that's our re-login signal.
// CC's own frontend refreshes just the antiforgery token on a 400 whose
// JSON body has `reason: "Antiforgery"`, and only does a full re-login on
// session expiry (401) — mirrored below.

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // ponytail: real expiry undocumented; conservative 6h, live 401/Antiforgery always forces a refresh regardless of this.

type CcSession = { cookieStr: string; requestToken: string };

function getSetCookies(res: Response): string[] {
  const withGetter = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie();
  const h = res.headers.get('set-cookie');
  return h ? h.split(/,(?=[^ ])/) : [];
}

// Merges Set-Cookie headers into an existing "k=v; k2=v2" cookie string,
// by cookie name (last write wins) — NOT a naive concat. CC re-sets a
// `.AspNetCore.Antiforgery.*` cookie on more than one step, and only the
// latest value pairs with the requestToken it was issued alongside.
function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const raw of setCookieHeaders) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return Array.from(jar.entries()).filter(([k, v]) => k && v).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(email: string, password: string): Promise<{ cookieStr: string }> {
  const getRes = await ccFetch(`${BASE_URL}/Account/Login`);
  const html = await getRes.text();
  const m = html.match(/__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/);
  if (!m) throw new Error('CardCenter login: __RequestVerificationToken not found on login page');
  const cookieStr = mergeCookies('', getSetCookies(getRes));

  const body = new URLSearchParams({
    Email: email,
    Password: password,
    RememberMe: 'false',
    __RequestVerificationToken: m[1],
  });
  // redirect: 'manual' — success is a 302 off the login page carrying the
  // real auth Set-Cookie; following it (fetch's default) would surface
  // only the destination page and lose that cookie.
  const postRes = await loggedFetch({ group: 'CC', userId: null }, `${BASE_URL}/Account/Login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...CC_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieStr },
    body: body.toString(),
  });
  if (postRes.status < 300 || postRes.status >= 400) {
    throw new Error(`CardCenter login failed (${postRes.status}) — check cc_email/cc_password`);
  }
  return { cookieStr: mergeCookies(cookieStr, getSetCookies(postRes)) };
}

async function fetchRequestToken(cookieStr: string): Promise<CcSession> {
  const res = await ccFetch(`${BASE_URL}/Api/AntiforgeryTokens`, { headers: { Cookie: cookieStr } });
  if (!res.ok) throw new Error(`CardCenter AntiforgeryTokens ${res.status}`);
  const merged = mergeCookies(cookieStr, getSetCookies(res));
  const data = await ccJson<{ requestToken?: string }>(res, 'AntiforgeryTokens');
  if (!data.requestToken) throw new Error('CardCenter AntiforgeryTokens: no requestToken in response');
  return { cookieStr: merged, requestToken: data.requestToken };
}

async function persistSession(userId: number | null, session: CcSession): Promise<void> {
  await Promise.all([
    upsertSetting(userId, 'cc_session_cookies', session.cookieStr),
    upsertSetting(userId, 'cc_session_token', session.requestToken),
    upsertSetting(userId, 'cc_session_expires', String(Date.now() + SESSION_TTL_MS)),
  ]);
}

async function establishSession(userId: number | null, email: string, password: string): Promise<CcSession> {
  const { cookieStr } = await login(email, password);
  const session = await fetchRequestToken(cookieStr);
  await persistSession(userId, session);
  return session;
}

async function getSession(userId: number | null, email: string, password: string): Promise<CcSession> {
  const [cookiesRow, tokenRow, expiresRow] = await Promise.all([
    getSetting(userId, 'cc_session_cookies'),
    getSetting(userId, 'cc_session_token'),
    getSetting(userId, 'cc_session_expires'),
  ]);
  const expires = expiresRow ? parseInt(expiresRow.value, 10) : 0;
  if (cookiesRow?.value && tokenRow?.value && Date.now() < expires) {
    return { cookieStr: cookiesRow.value, requestToken: tokenRow.value };
  }
  return establishSession(userId, email, password);
}

export type CcAuth = { userId: number | null; email: string; password: string };

// Authenticated call to a CardCenter /Api/* path. Handles session caching,
// antiforgery-token refresh (400 with body `reason: "Antiforgery"` — CC's
// own frontend's pattern), and full re-login (401 — expired/no session)
// transparently. `path` is relative, e.g. `/Api/Reservations`.
export async function ccApiFetch(
  userId: number | null,
  email: string,
  password: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let session = await getSession(userId, email, password);

  const attempt = (s: CcSession) => ccFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Cookie: s.cookieStr,
      RequestVerificationToken: s.requestToken,
    },
  });

  let res = await attempt(session);

  if (res.status === 401) {
    session = await establishSession(userId, email, password);
    res = await attempt(session);
    return res;
  }

  if (res.status === 400) {
    const bodyText = await res.clone().text().catch(() => '');
    if (/"reason"\s*:\s*"Antiforgery"/.test(bodyText)) {
      session = await fetchRequestToken(session.cookieStr);
      await persistSession(userId, session);
      res = await attempt(session);
    }
  }

  return res;
}

interface CcBrand {
  id: number;
  name: string;
  slug: string;
  type: string;
  image: { id: string };
}

interface CcReservation {
  id: number;
  date: string;
  seller: { id: number; email: string };
  brand: CcBrand;
  buyOrder: { id: number; value: number; brand: CcBrand; buyer: { id: number; displayName: string; email: string } };
  value: number;
  quantity: number;
  rate: number;
  submissionTerms: number;
  paymentTerms: number;
  flexType: string;
  status: string;
  expired: boolean;
  submissionDeadline: string;
  submissionToken: string;
  permissions: Record<string, boolean>;
}


export interface CcPaymentListing {
  amount: number;
  listing: {
    id: number;           // listing ID (e.g. 9045043) — NOT what we store as ccGiftCardId
    giftCard: { id: number; code?: string }; // giftCard.id (e.g. 8232432) IS what we store as ccGiftCardId
    value: number;
    brand: CcBrand;
    purchasePrice: number;
    purchasePaid: number;
    paymentDueDate: string;
    paymentSentOn: string;
    paymentReceivedOn: string;
    createdAt: string;
    purchasedAt: string;
  };
}

export interface CcPayment {
  id?: number;
  name: string;
  amount: number;
  status: string;
  date: string;
  receivedOn: string;
  listings?: CcPaymentListing[];
}

export async function getPaymentDetail(auth: CcAuth, paymentId: string): Promise<CcPayment> {
  const res = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Payments/${encodeURIComponent(paymentId)}`);
  if (!res.ok) throw new Error(`CardCenter payment ${res.status}`);
  return ccJson<CcPayment>(res, `Payments/${paymentId}`);
}

export interface CcSubmitResult {
  submitted: number[];   // card IDs that succeeded
  duplicate: number[];   // card IDs CardCenter says are already submitted
  failed: number[];      // card IDs that errored
  rawError?: string;
  ccGiftCardIds?: Array<{ code: string; ccGiftCardId: string; paymentReceivedOn?: string; purchasePrice?: number }>;
  paymentName?: string;  // e.g. "P1056-20260703" — derived from seller ID + paymentReceivedOn
  salePrice?: number;    // sum of purchasePrice across all submitted cards
}

export async function submitCards(
  auth: CcAuth,
  cards: Array<{ id: number; code: string; merchant: string; value: number; ccReservationId: number | null }>,
): Promise<CcSubmitResult> {
  const result: CcSubmitResult = { submitted: [], duplicate: [], failed: [] };

  // Group by ccReservationId; cards without one are failed immediately
  const byReservation = new Map<number, typeof cards>();
  for (const card of cards) {
    if (!card.ccReservationId) {
      result.failed.push(card.id);
      if (!result.rawError) result.rawError = 'Some cards have no reservation — create one first';
      continue;
    }
    if (!byReservation.has(card.ccReservationId)) byReservation.set(card.ccReservationId, []);
    byReservation.get(card.ccReservationId)!.push(card);
  }

  // Reservation groups are independent of each other — the sequential
  // chain of calls (fetch reservation → parse cards → submit → fetch
  // detail) stays intact WITHIN a group, but groups themselves run
  // concurrently instead of one at a time.
  //
  // paymentName is a single string field — it can't represent multiple
  // groups' payment labels (that was already true before this ran
  // concurrently; the real per-card payment reconciliation lives in
  // ccGiftCardId + sync-payments, not this field). Concurrency just made
  // *which* group's label wins nondeterministic instead of consistently
  // "whichever ran last in the loop" — pin it back to a fixed, deterministic
  // choice (lowest reservation ID) so re-running submitCards on the same
  // input always produces the same paymentName.
  const minReservationId = Math.min(...byReservation.keys());
  await Promise.all(Array.from(byReservation.entries()).map(async ([reservationId, groupCards]) => {
    try {
      // Fetch the full reservation to get seller info
      const reservationRes = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Reservations/${reservationId}`);
      if (!reservationRes.ok) {
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = `Reservation ${reservationId} not found (${reservationRes.status})`;
        return;
      }
      const reservation = await ccJson<CcReservation & { submissionInstructions?: unknown; sellerAgreement?: unknown }>(reservationRes, `Reservations/${reservationId}`);

      if (reservation.expired || reservation.status !== 'Approved') {
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = `Reservation ${reservationId} is ${reservation.expired ? 'expired' : reservation.status} — create a new reservation`;
        return;
      }

      // Parse card codes — CardCenter validates them and returns the submission structure
      const codes = groupCards.map(c => c.code).join('\n');
      const parseRes = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Reservations/${reservationId}/ParsedCards`, {
        method: 'POST',
        body: JSON.stringify({ text: codes }),
      });
      if (!parseRes.ok) {
        const text = await parseRes.text().catch(() => String(parseRes.status));
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = `ParsedCards failed: ${text}`;
        return;
      }
      type ParsedCard = { brand: unknown; value: unknown; code: string };
      type ParsedGroup = { brand: unknown; value: unknown; quantity: number; offers: Array<{ reservation: Record<string, unknown> }> };
      const parsed = await ccJson<{
        cards: Array<ParsedCard>;
        submission: {
          groups: Array<ParsedGroup>;
          sellerAgreement?: { agreement?: { id: string; date: string } };
        };
      }>(parseRes, `Reservations/${reservationId}/ParsedCards`);

      const firstOffer = parsed.submission.groups[0]?.offers?.[0];
      if (!firstOffer?.reservation) {
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = 'ParsedCards returned no reservation in offers';
        return;
      }
      const seller = firstOffer.reservation.seller as { id: number; email: string };
      const acceptAgreement = parsed.submission.sellerAgreement?.agreement;
      let cardIdx = 0;
      const groups = parsed.submission.groups.map(g => {
        const cards = parsed.cards.slice(cardIdx, cardIdx + g.quantity);
        cardIdx += g.quantity;
        return { brand: g.brand, value: g.value, quantity: g.quantity, reservation: g.offers[0].reservation, cards };
      });
      const submissionBody = { seller, groups, ...(acceptAgreement ? { acceptAgreement } : {}) };
      const submitRes = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Submissions`, {
        method: 'POST',
        body: JSON.stringify(submissionBody),
      });

      if (submitRes.ok) {
        for (const c of groupCards) result.submitted.push(c.id);
        try {
          type SubmissionDetail = {
            id: string;
            groups: Array<{ submittedCards?: Array<{ giftCard: { id: number; code: string }; paymentReceivedOn: string; purchasePrice: number }> }>;
          };
          const submitData = await ccJson<SubmissionDetail>(submitRes, 'Submissions');
          const detailRes = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Submissions/${submitData.id}`);
          if (detailRes.ok) {
            const detail = await ccJson<SubmissionDetail>(detailRes, `Submissions/${submitData.id}`);
            const submittedCards = detail.groups.flatMap(g => g.submittedCards ?? []);
            if (!result.ccGiftCardIds) result.ccGiftCardIds = [];
            for (const sc of submittedCards) {
              result.ccGiftCardIds.push({
                code: sc.giftCard.code,
                ccGiftCardId: String(sc.giftCard.id),
                paymentReceivedOn: sc.paymentReceivedOn,
                purchasePrice: sc.purchasePrice,
              });
            }
            const receivedOn = submittedCards[0]?.paymentReceivedOn;
            if (receivedOn && reservationId === minReservationId) {
              result.paymentName = `P${seller.id}-${receivedOn.replace(/-/g, '')}`;
            }
            // Groups now run concurrently (see comment above), so this must
            // accumulate across groups, not overwrite — salePrice is documented
            // as "sum of purchasePrice across all submitted cards" (plural).
            result.salePrice = (result.salePrice ?? 0) + submittedCards.reduce((sum, sc) => sum + sc.purchasePrice, 0);
          }
        } catch {
          // Non-fatal: gift card IDs won't be populated but submission succeeded
        }
      } else {
        const text = await submitRes.text().catch(() => '');
        if (submitRes.status === 409 || /already|duplicate|exist/i.test(text)) {
          for (const c of groupCards) result.duplicate.push(c.id);
        } else {
          for (const c of groupCards) result.failed.push(c.id);
          result.rawError = text || String(submitRes.status);
        }
      }
    } catch (e) {
      for (const c of groupCards) result.failed.push(c.id);
      result.rawError = String(e);
    }
  }));

  return result;
}
