# TASK: rt-ccwaitlist-cases

## Confirmed defect (observed, not suspected)

`lib/ccWaitlist.ts` is missing from the baseline tree entirely (`git show HEAD:lib/ccWaitlist.ts` fails; the file does not exist at HEAD), so nothing in the repo can decide whether an UNSOLD gift card gets sold to CardCenter today. The adversarial fixture `verify.test.ts` imports `decideWaitlist`, `runWaitlist`, `pickCurrentRate` and `planWaitlistRun` from `./lib/ccWaitlist.ts` and fails at baseline with a missing-module error; the literal gate also fails because none of the required symbols exist.

## Entry point

lib/ccWaitlist.ts:1 (the whole module — decision core, batch runner, rate picker, planner)

## Required change

Author the adversarial cases for the CardCenter waitlist decision core, lib/ccWaitlist.ts. The reference implementation is written and is the file's current content — your job is the harness that proves it, not a rewrite. The module decides whether an UNSOLD gift card gets sold to CardCenter today: the user parks a card with a target sell rate and a deadline, and a batch runner looks up what CardCenter is currently paying for that brand and denomination and either submits it, keeps waiting, or lets it expire. Real money moves on these decisions, so the cases must pin the properties that cost money when wrong: the deadline is INCLUSIVE, so today === maxDate still decides on rate and only today > maxDate expires; the deadline is checked BEFORE the rate, so a lapsed card never submits however good the rate is; the rate test is >=, so hitting the target exactly submits and a hair under waits; WAIT fires neither hook; a hook that throws is recorded as exactly one {id, message} entry in errors, that id is NOT counted as submitted or expired, and the run continues through the remaining cards instead of aborting; a thrown bare string is still a readable message; and a card with no usable rate at all may EXPIRE but must never SUBMIT, because there would be nothing to submit against. For rate selection the edge cases are: brand matching is case-insensitive bidirectional substring after trimming and collapsing internal whitespace, so 'Best Buy' matches 'best buy ' but NOT 'BestBuy'; the denomination must match within a cent; a row whose availableCap is 0 is unusable and must be skipped in favour of another matching row rather than failing the card; the highest surviving rate wins with the lowest id breaking ties; and an empty rate list yields null. Nothing may read the clock — the day is always passed in.

The module must keep loading under `node --experimental-strip-types` (no path aliases, no decorators). Rates are FRACTIONS of face value (0.85 = 85%), the unit CardCenter's own API returns. Dates are 'YYYY-MM-DD' strings compared lexicographically.

The "within a cent" denomination check needs a float-noise guard: `Math.abs(r.value - card.value) > 0.01` is not safe on its own -- in IEEE 754, `50.02 - 50.01` evaluates to `0.010000000000005116`, which IS `> 0.01`, so a literal reading of the spec rejects a row that is actually exactly a cent off. Compare against `0.01 + 1e-9` (or an equivalent small epsilon), not bare `0.01`. The adversarial fixture's denomination test (`value: 50.02` matching a `value: 50.01` row) exercises exactly this boundary and will fail without the epsilon.

Behaviour that must NOT change:
- The four exports keep their exact names and signatures: `decideWaitlist`, `runWaitlist` (async), `pickCurrentRate`, `planWaitlistRun`.
- `runWaitlist` never throws out of the loop; hook failures are data, not control flow.
- No DB access, no network, no clock read anywhere in the module — pure functions only.

## Must contain

- `export function decideWaitlist(card: WaitlistCard, currentRate: number, today: string): WaitlistDecision`
- `if (today > card.maxDate) return 'EXPIRE';`
- `if (currentRate >= card.targetRate) return 'SUBMIT';`
- `export async function runWaitlist(`
- `summary.errors.push({ id: card.id, message: toMessage(e) });`
- `export function pickCurrentRate(`
- `if (r.availableCap <= 0) continue;`
- `(bn.includes(brand) || brand.includes(bn))`
- `Math.abs(r.value - card.value) > 0.01`
- `r.rate === best.rate && r.id < best.id`
- `export function planWaitlistRun(`
- `today > card.maxDate ? 'EXPIRE' : 'WAIT'`

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
This is not about adding bogus assertions for constants; it's about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
