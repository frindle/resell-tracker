# TASK: amazon-iris-frame-diagnosis (diagnosis)

## Confirmed symptom (observed, not suspected)

confirmed: Amazon order 917 imported with cardId=null. The payment now renders in an iris.apx.amazon.dev widget with its own __NEXT_DATA__ (a cross-origin Next.js iframe); the scraper's 5 last-4 regexes run against paymentSearchText/cardText (textContent of the order document) and never see the iframe's '•••• 3069', so paymentLast4=undefined.

## The question to answer

Pin, from the code only: (1) exactly where paymentSearchText and cardText are built and prove they read ONLY the main document (no page.frames()/frame.evaluate for payment anywhere in the file); (2) whether extractDetailInBrowser/scrapeDocInBrowser run INSIDE page.evaluate (so they cannot reach a cross-origin frame); (3) the exact Puppeteer-level function+line (OUTSIDE any page.evaluate) where a page.frames() traversal targeting iris.apx.amazon.dev should hook in, and how the extracted lastDigits would flow back into the returned order object + /api/import payload.

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
