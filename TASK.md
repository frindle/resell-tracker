# TASK: orders-row-spacing (diagnosis)

## Confirmed symptom (observed, not suspected)

CONFIRMED via screenshot (v1.2.0, prod reselling.penndalton.com Orders page): each row in the Orders table renders ~500px tall with cell content anchored to the top, leaving a huge empty vertical gap below every row. Previously compact rows; recent layout regression. Data/values render fine — purely row height / vertical spacing.

## The question to answer

Identify the exact file+line and CSS/JSX change causing Orders table rows to render with excessive height/vertical gap, and name the minimal fix.

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

## Scope

This is a READ-ONLY investigation. Edit ONLY `DIAGNOSIS.md`. Do not modify any source
file, `verify.sh`, `REPO_MAP.md`, or `TASK.md`.

## Loop instruction

Run `bash verify.sh` to confirm DIAGNOSIS.md exists and is non-empty, then stop.
