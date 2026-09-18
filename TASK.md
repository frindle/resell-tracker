# TASK: cc-waitlist-r2-s4-on

## Confirmed defect (observed, not suspected)

A card whose waitlist window ends today is treated as lapsed. Reproduced by
evaluating the decision for a card `{ id: 7, minDate: null, maxDate: '2026-03-15' }`
with `today = '2026-03-15'`: it comes back EXPIRE and the runner surfaces it
through `onExpire` instead of submitting. The boundary day must be eligible;
expiry starts only on the NEXT day after maxDate.

## Entry point

lib/ccWaitlist.ts -- `decideWaitlist(card, today)` (the decision) and
`runWaitlist(cards, today, hooks)` (the batch runner).

## Required change

In lib/ccWaitlist.ts: today == maxDate day is still eligible. A runner iterates candidate cards, applies the decision, calls an injected submit function on SUBMIT and an injected onExpire function on EXPIRE (to surface the lapsed waitlist), and returns a summary {submitted, waiting, expired, errors}.

Exact contract:
- `decideWaitlist(card, today)` is pure. Dates are YYYY-MM-DD strings compared
  lexicographically. A card is eligible while `today` falls inside its inclusive
  window `[minDate, maxDate]`: `maxDate < today` -> EXPIRE; else
  `minDate != null && minDate > today` -> WAITING; otherwise SUBMIT. In
  particular `today == maxDate` and `today == minDate` are both SUBMIT-eligible.
- `runWaitlist(cards, today, hooks)` is async and iterates cards in input order.
  `hooks.submit(card)` is called for each SUBMIT card; `hooks.onExpire(card)` is
  called for each EXPIRE card (to surface the lapsed waitlist); WAITING cards
  trigger neither hook. Both hooks may be sync or async and are awaited.
- It returns a summary object with exactly these fields: `submitted`, `waiting`
  and `expired` are arrays of the card ids in input order; `errors` is an array
  of `{ id, message }` entries where `id` is the card id (or null when the card
  has none) and `message` is a non-empty string.
- Failure handling: if a hook throws, or a card is malformed (e.g. missing
  `maxDate`), record ONE entry in `errors` for that card and CONTINUE with the
  next card -- never abort the batch, never let it throw out of runWaitlist.
  Use an Error's `.message`; stringify non-Error throws. A card whose hook threw
  is NOT counted in submitted/expired/waiting.

Behaviour that must NOT change:
- Cards strictly inside their window still submit exactly once, in input order.
- WAITING cards appear only in `waiting` and trigger neither hook.
- A throwing hook on one card does not prevent later cards from being processed.

## Must contain

- `decideWaitlist`
- `runWaitlist`
- `'SUBMIT'`
- `'WAITING'`
- `'EXPIRE'`
- `onExpire`
- `submitted`
- `waiting`
- `expired`
- `errors`

## Scope

Only edit `lib/ccWaitlist.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
