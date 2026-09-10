# TASK: bfmr-orphan-link-creator (diagnosis)

## Confirmed symptom (observed, not suspected)

CONFIRMED via live API (order 768): two OrderBfmrLink rows, BOTH reservationId=NULL — link 97 (qty2, value 598, no tracking) + phantom link 161 (qty1, value 299, tracking 9339589725265624... ). Their values sum to 897 = the inflated order.bgExpectedPayout; order.salePrice=598 is already correct. The two reservations for this order (6481, 216286) share reserveId w3klQsdza3PVH4inKlhq_A== but differ in purchaseId/shipmentId — BFMR split ONE reservation into two shipments. Because both links have reservationId=NULL, the reservation-split branch in applySubmittedTrackingToLinks (which stamps reservationId on its sibling and only queries links WHERE reservationId) did NOT create them and can be ruled out.

## The question to answer

Answer TWO things: (1) which code path CREATES an OrderBfmrLink with reservationId=null, and which of those fires when a BFMR reservation is split across shipments/purchaseIds — giving the file:line of the create call and the trigger; (2) why does order.bgExpectedPayout count BOTH links (=897) while recalcBfmrSalePrice / order.salePrice does not (=598) — i.e. the two totals are computed by different code with different link-inclusion rules; name both.

## SEARCH PLAN -- do these IN ORDER, and STOP as soon as you can answer the question

1. Read `REPO_MAP.md` at the repo root FIRST. It has a file->exported-symbols index
   and a "computation digest" (where quantities/counts/totals are summed or reduced).
   Use it to LOCALIZE the relevant code -- do NOT grep blind.
2. From the map, open ONLY the 1-3 files most likely to hold the answer. Read each once.
3. Grep ONLY to CONFIRM a specific location the map pointed you to (e.g. one symbol,
   one file:line) -- never to discover from scratch what the map already lists.
4. As soon as you can name the root cause with a file:line, STOP searching and write
   `DIAGNOSIS.md` immediately. Do not keep exploring "to be thorough".

STOP condition: you have a file:line + a one-paragraph mechanism for the symptom.
Read budget: at most ~8 file reads / greps total. If you approach that, WRITE your
best current finding to DIAGNOSIS.md now rather than reading more.
Do NOT re-grep or re-read a file you have already seen this run -- act on what you found.

## Required output

Write `DIAGNOSIS.md` at the repo root containing:
- Root cause: the file:line where the problem originates, and the mechanism (why).
- Evidence: the specific code/values you saw that prove it (quote them).
- Fix sketch: one paragraph on what change would resolve it (do NOT make the change).
- Falsifiable prediction: one concrete, checkable claim that MUST be true if this
  mechanism is the cause and would be FALSE if it isn't -- something a reviewer can
  confirm against the code or the live data without trusting your reasoning. State
  the exact check (e.g. "row X will have field F = null", "deleting Y drops total by
  Z", "this branch conserves the summed value, so it cannot change the total"). A
  mechanism with no falsifiable prediction is a guess; a wrong mechanism usually
  makes a prediction that the data contradicts, which is how a bad diagnosis is caught.

## Scope

This is a READ-ONLY investigation. Edit ONLY `DIAGNOSIS.md`. Do not modify any source
file, `verify.sh`, `REPO_MAP.md`, or `TASK.md`.

## Loop instruction

Run `bash verify.sh` to confirm DIAGNOSIS.md exists and is non-empty, then stop.
