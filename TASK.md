# TASK: amazon-card-nomatch-diagnosis (diagnosis)

## Confirmed symptom (observed via live API, not suspected)

Amazon order 917 (order# 111-3217421-9990618, orderDate 2026-09-11, cost 299.97,
item "Fitbit Google Air - Screenless Activity Tracker - Berry") imported with
`cardId = null` (no credit card auto-assigned). It is the ONLY order of the 60
most-recent with a null card; 24 OTHER recent Amazon orders in the same window
all got a card assigned. So the auto-assign path works in general but failed for
this one import. Penn's read: "Amazon may have changed how they show cards."

The `OrderBfmrLink`/order schema shows `Order.cardId Int?` and
`CreditCard.last4 String?` with the comment: last4 is "used for auto-assigning a
card on order import when the scraped payment method matches". Order 917 stores
NO raw scraped payment string anywhere in its record (checked: notes=null, no
payment field), so when the match failed the input was discarded and only
`cardId=null` remains.

## The question to answer

1. WHERE on the SERVER is the scraped Amazon payment method turned into a last-4
   and matched against `CreditCard.last4` (and the authorized-user
   `CreditCardLastFour.last4`) to set `order.cardId` on import? Give the
   file:line of (a) the last-4 EXTRACTION from the payment string and (b) the
   MATCH that sets cardId.
2. What payment-method string formats does that extraction currently handle?
   Quote the exact regex / substring / parse logic. Then name the SPECIFIC parse
   step that would yield no last-4 (leaving cardId null) if Amazon changed the
   displayed payment format (e.g. a new label, spacing, masking character, or a
   wallet/"Amazon Visa" style string). Be concrete about what shape breaks it.
3. Is the raw scraped payment string persisted ANYWHERE on import? If not, name
   the exact spot it should be captured so a future format change is diagnosable
   from the DB instead of being silently dropped.

## SEARCH PLAN -- in order, STOP as soon as you can answer

1. Read `REPO_MAP.md` at the repo root FIRST -- file->symbols index + a
   "computation digest". Localize the order-import + card-match path from it.
2. Open ONLY the 1-3 files most likely to hold the extraction/match. Read each once.
3. Grep ONLY to CONFIRM a specific file:line the map pointed you to.
4. As soon as you can name the extraction + match file:line and the failing
   parse step, STOP and write DIAGNOSIS.md.

Read budget: ~8 reads/greps. Do NOT re-read a file you have already seen.

## Required output

Write `DIAGNOSIS.md` at the repo root with:
- Root cause: the file:line where the last-4 extraction/match happens and the
  mechanism -- why a changed Amazon payment format yields cardId=null.
- Evidence: quote the actual extraction/match code you saw.
- Fix sketch: one paragraph -- what change makes the matcher tolerate the new
  format (or capture the raw payment for diagnosis). Do NOT make the change.
- Falsifiable prediction: one concrete checkable claim that MUST be true if this
  mechanism is the cause and FALSE otherwise -- e.g. "the extraction regex
  requires the literal token X; a payment string lacking X returns no last-4",
  or "for every other recent Amazon order the scraped payment contains pattern P
  and order 917's did not". State the exact check a reviewer can run against the
  code or live data without trusting your reasoning.

## Scope

READ-ONLY. Edit ONLY `DIAGNOSIS.md`. Do not modify any source file, verify.sh,
REPO_MAP.md, or TASK.md.

## Loop instruction

Run `bash verify.sh` to confirm DIAGNOSIS.md exists with the required sections,
then stop.
