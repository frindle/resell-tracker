# TASK: bfmrWeb

## Confirmed defect (observed, not suspected)

BFMR web-login — used for the myTrackerId backfill in sync-reservations — now
fails with a 403 because BFMR added Google reCAPTCHA v3 to POST /api/login.
Confirmed via docker logs ("BFMR web login 403") and a captured real-browser
login response showing a JWT with a 30-DAY lifetime (iat/exp diff = 2,592,000s),
while `lib/bfmrWeb.ts` getSession() hard-codes SESSION_TTL_MS = 50 minutes and
therefore calls the reCAPTCHA-gated login() far more often than the token
actually requires.

## Entry point

`lib/bfmrWeb.ts`: getSession() (the cached-session validity check) and the new
manual-seed surface it must expose for `app/api/bfmr/web-session-seed/route.ts`.

## Required change

Two parts, NO browser automation / NO calling BFMR /api/login from server code
differently — this is a caching-window + manual-seed fix only:

1. **JWT-aware session validity in getSession().** Add an exported helper
   `decodeJwtExpiry(token: string): number | null` that base64url-decodes the
   middle segment of the JWT, JSON.parses it, and returns the real `exp` claim
   (unix seconds) as unix-ms; return `null` when the token is not a decodable
   three-segment JWT, the payload is not valid base64url JSON, or exp is
   missing/non-numeric. In getSession(), when checking whether the cached
   session in settings (`bfmr_session_token/xsrf/cookies/expires`) is still
   valid, use `decodeJwtExpiry(token)` minus a 5-minute safety margin as the
   actual expiry instead of always trusting the stored `bfmr_session_expires`
   timestamp computed from the fixed 50-minute TTL. If the JWT cannot be
   decoded (helper returns null), fall back to the existing 50-minute-TTL
   behavior unchanged.

2. **Manual session seed.** Add an exported helper in `lib/bfmrWeb.ts`,
   `seedBfmrWebSession(userId, token, xsrf = '', cookieStr = '')`, that upserts
   the same settings keys getSession() reads (`bfmr_session_token`,
   `bfmr_session_xsrf`, `bfmr_session_cookies`, `bfmr_session_expires` — expires
   computed from the decoded JWT exp claim via decodeJwtExpiry, falling back to
   now + SESSION_TTL_MS when undecodable) and returns `{ expires }`. Then add a
   new POST API route `app/api/bfmr/web-session-seed/route.ts` that accepts a
   JSON body `{token: string, xsrf?: string, cookieStr?: string}` (or the raw
   BFMR /api/login response shape — extract `data.user.auth_token` as token),
   auth-gated the same way other authenticated app API routes in this project
   are (`getSessionUserId()` from `@/lib/auth`, 401 when null — see
   `app/api/bfmr/web-login/route.ts` for the idiom; do not invent a new auth
   scheme), returning 200 `{ok: true, expires}` on success and 400 (not 500)
   for invalid JSON or a missing token.

Do NOT change submit/sync business logic, response shapes, or any other
exported function signature in bfmrWeb.ts. Preserve every existing import,
function, class, and re-export already in the file — this is an additive fix.

Behaviour that must NOT change:
- `getProfile`, `getDeals`, `getDealItems`, `checkAndReserve`,
  `submitTracking`, `reconcileReservationSubmission`, `pushReservationOrderNumber`,
  `cancelReservation`, `getWebTrackerRows` keep their exact signatures and
  behavior.
- login() still runs when the cached session is genuinely expired (JWT exp in
  the past) or absent, and re-caches with now + SESSION_TTL_MS as before.
- Undecodable tokens: getSession() falls back to the stored
  `bfmr_session_expires` exactly like today; seedBfmrWebSession stores
  now + SESSION_TTL_MS.

## Must contain

- `export function decodeJwtExpiry(token: string): number | null {`
- `const JWT_EXPIRY_MARGIN_MS = 5 * 60 * 1000;`
- `export async function seedBfmrWebSession(`
- `bfmr_session_token`
- `bfmr_session_xsrf`
- `bfmr_session_cookies`
- `bfmr_session_expires`
- in app/api/bfmr/web-session-seed/route.ts: `export async function POST(req: Request) {`
- in app/api/bfmr/web-session-seed/route.ts: `getSessionUserId()`
- in app/api/bfmr/web-session-seed/route.ts: `auth_token`

## Scope

Only edit `lib/bfmrWeb.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as
  a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
