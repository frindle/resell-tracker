# TASK: rt-emailsync-imap-configurable

## Confirmed defect (observed, not suspected)

`lib/emailSync.ts` hardcodes the IMAP endpoint and folder inside `fetchOrderEmails`:
the `ImapFlow` constructor is built with literal `host: 'imap.gmail.com'`,
`port: 993`, `secure: true`, and the mailbox lock is taken on literal `'INBOX'`.
Verified by reading the source (lines ~100-112): there is no way to point
`fetchOrderEmails` at a non-Gmail IMAP server such as Proton Mail Bridge, nor at
any folder other than INBOX. `deleteEmail`/`deleteEmails` carry the same literals
but are out of scope here.

## Entry point

lib/emailSync.ts:99 (`fetchOrderEmails`) — and its `EmailCredentials` type at line 4.

## Required change

Add optional host/port/secure/mailbox fields to EmailCredentials in lib/emailSync.ts and make fetchOrderEmails use them instead of the hardcoded imap.gmail.com:993 and getMailboxLock('INBOX'), so a non-Gmail IMAP server (Proton Mail Bridge) and a specific folder can be targeted, while every new field defaults to today's exact Gmail/INBOX behavior when omitted so existing callers are unaffected.

Behaviour that must NOT change:
- `fetchOrderEmails({address, appPassword})` with no new fields connects exactly as today: host `imap.gmail.com`, port `993`, secure `true`, mailbox lock on `INBOX`.
- The ImapFlow config still passes `auth: { user: creds.address, pass: creds.appPassword }` and `logger: false`.
- Search criteria, the 100-message cap, parsing/sorting of results are untouched.
- `deleteEmail` and `deleteEmails` keep their literal `imap.gmail.com` / `993` / `true` / `'INBOX'` / `[Gmail]/Trash` exactly as today — do not modify them.
- No other file changes; callers (e.g. app/api/email/sync/route.ts) are untouched and must keep compiling against the widened type.

## Must contain

- `host?: string`
- `port?: number`
- `secure?: boolean`
- `mailbox?: string`
- `creds.host ?? 'imap.gmail.com'`
- `creds.port ?? 993`
- `creds.secure ?? true`
- `creds.mailbox ?? 'INBOX'`

## Scope

Only edit `lib/emailSync.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
