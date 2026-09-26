# TASK: bfmr-stale-link-migration

## Confirmed defect (observed, not suspected)

A bare reservation row (`purchaseId=null`, `shipmentId=null`) that already has an
`OrderBfmrLink` gets orphaned when BFMR assigns a purchaseId to the same
reservation: the sync sees the now-purchased reservation as new and creates a NEW
local row instead of updating the bare one in place. The result is two local rows
for one live reservation — the stale bare row still carrying its `OrderBfmrLink`,
and the live unlinked sibling with none. Observed on the account's duplicate-on-
purchase pairs: the link sits on the dead row, so tracking submits against the
live row 409 while the old row is never cleaned up.

## Entry point

lib/bfmrJoin.ts — next to `matchSplitGroups` (the split-resolution function in
this same file). The new function must sit beside it and follow its style: a doc
comment explaining WHY, pure logic, no imports.

## Required change

Add resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows) to lib/bfmrJoin.ts: reconciles the BFMR reservation duplicate-on-purchase bug where a bare (purchaseId=null,shipmentId=null) reservation row that already has an OrderBfmrLink gets orphaned when BFMR assigns a purchaseId and the sync creates a NEW row instead of updating in place. The function must return which OrderBfmrLink(s) to move from the stale bare row onto its live unlinked sibling, but ONLY when unambiguous: group both input arrays by reserveId (skip null/empty reserveId), and for a group emit {fromId,toId} only when there is EXACTLY ONE bare-linked row in that group AND exactly one live-unlinked row in that group whose qty exactly equals the bare row's qty. Any other case (0 or >1 bare-linked rows, or 0 or >1 qty-matching live-unlinked rows) must resolve to NOTHING for that group -- never guess. A real BFMR split divides qty across sibling rows so it never produces an exact qty match here, and must be left untouched -- same discipline as the existing matchSplitGroups function in this same file, which this new function must sit next to and follow the style of (doc comment explaining WHY, pure/no imports).

Exact contract:

```ts
export function resolveStaleReservationLinkMigrations(
  bareLinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>,
  liveUnlinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>,
): Array<{ fromId: number; toId: number }>
```

- Group both input arrays by `reserveId`; rows with a null or empty-string
  `reserveId` are skipped entirely (they cannot be grouped).
- For each reserveId group, emit `{ fromId: <bare row id>, toId: <live row id> }`
  ONLY when the group contains EXACTLY ONE bare-linked row AND exactly one
  live-unlinked row whose `qty` exactly equals that bare row's `qty`.
- Any other shape of a group (0 or >1 bare-linked rows, or 0 or >1 qty-matching
  live-unlinked rows) resolves to NOTHING for that group. Never guess.
- A real BFMR split divides qty across sibling rows, so it never produces an
  exact qty match here and must be left untouched — same "zero or ambiguous ->
  stay null" discipline as `matchSplitGroups`.

Behaviour that must NOT change:
- Every existing export in lib/bfmrJoin.ts (`normalizeBfmrTimestamp`,
  `bfmrJoinKey`, `bfmrSplitGroupKey`, `matchSplitGroups`,
  `BACKFILL_KEY_SAMPLES`, `normalizeBackfillLocal`, `resolveTrackerBackfill`,
  `buildOrderIdTrackerRow`) keeps its exact current behaviour.
- The file stays import-free (no new imports) and pure — no DB, fetch, or side
  effects.

## Must contain

- `export function resolveStaleReservationLinkMigrations(`
- `bareLinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>`
- `liveUnlinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>`
- `Array<{ fromId: number; toId: number }>`

## Scope

Only edit `lib/bfmrJoin.ts`; do not edit `verify.sh`, `test_fixture.py` or `TASK.md`.
test_fixture.py is the test fixture -- changing it invalidates the check.

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
