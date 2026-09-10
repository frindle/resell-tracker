# TASK: bfmr-orphan-link-creator (diagnosis)

## Confirmed symptom (observed, not suspected)

CONFIRMED via live API (order 768). The order has TWO OrderBfmrLink rows, each tied (by FK) to its own BfmrReservation:
- link 97 -> reservation 6481. Reservation 6481 is qty=1, totalPayout=299. But link 97 is quantity=2, value=598 -- it OVER-ALLOCATES its reservation (link qty 2 > reservation qty 1; value 598 > payout 299).
- link 161 -> reservation 216286 (qty=1, totalPayout=299). Link 161 is quantity=1, value=299 -- CORRECT.
Link values sum to 897 = the inflated order.bgExpectedPayout; order.salePrice=598 is already correct.
Reservations 6481 and 216286 share reserveId w3klQsdza3PVH4inKlhq_A== but differ in purchaseId/shipmentId: BFMR split ONE original reservation (qty 2) into two qty-1 reservations across two shipments. The evident history: originally there was one reservation (later 6481) at qty 2 with one link 97 at qty 2 / value 598. A sync then observed BFMR's split -- it shrank reservation 6481 to qty 1 and created the sibling reservation 216286 (qty 1) plus its correct link 161 (qty 1 / 299) -- but it LEFT link 97 at its pre-split quantity 2 / value 598 instead of reducing it to match reservation 6481's new qty 1 / payout 299. reservationId is NON-NULL on both links (schema: OrderBfmrLink.reservationId Int, required) -- there is no orphan/null-reservation link; that earlier framing was an API-serialization artifact and is WRONG.

## The question to answer

Answer TWO things: (1) In the reservation-sync path (look at app/api/bfmr/sync-reservations and lib/bfmrAutoLink.ts and anything they call), when a BFMR reservation is SPLIT into smaller reservations — the existing reservation's qty shrinks and a new sibling reservation is created — where should the EXISTING OrderBfmrLink's quantity/value be reduced to match the shrunk reservation, and why is it not (give the file:line where the reservation qty is updated but the link is left untouched)? (2) Why does order.bgExpectedPayout count the full over-allocated link (=897) while recalcBfmrSalePrice / order.salePrice does not (=598) — the two totals are computed by different code with different per-link rules; name both file:line and the rule each uses.

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
