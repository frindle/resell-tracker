# TASK: egiftPrint

## Confirmed defect (observed, not suspected)

NEW FEATURE (no defect): the sidecar has no parser for the Costco eGift print page (memberedelivery.com /pages/print-page.xhtml). `sidecar/src/costcoEgiftPrint.js` is a stub (`export {};`) at baseline. Verified by reading the file.

## Entry point

sidecar/src/costcoEgiftPrint.js:1 (replace the stub entirely; CommonJS, `'use strict'`, `module.exports = { parsePrintPage }`).

## Required change

Implement `parsePrintPage(html)`: a PURE function over an HTML string (what `page.content()` returns on the print page). No require of playwright/fs/net, no I/O, no new dependencies, NEVER throws. The page is JSF/PrimeFaces (`j_idt*` ids unstable) and the card body is an EMAIL-STYLE NESTED TABLE template, so the code cell has no id: locate it by LABEL TEXT.

Contract:
- Non-string input -> `{ ok: false, reason: 'invalid-input' }`.
- First remove HTML comments and `<script>`/`<style>` elements: markup inside them is not part of the page.
- PAGER: the element with `id="wdt-page-counter"` (any tag, any attribute order, single or double quotes). Its text, trimmed, must match `^(\d+)\s+of\s+(\d+)$` with `1 <= N <= M`; otherwise (missing, malformed, 0, N > M) -> `{ ok: false, reason: 'no-pager' }`. Counters elsewhere on the page ("Page 9 of 99") are ignored.
- CELLS: consider only LEAF cells: `<td>`/`<th>` elements that contain no nested `td|th|table|tr` tag (outer layout cells wrap whole tables and would also "contain" the label).
- CODE: a label cell is a leaf cell whose own text, after removing any `<span>` elements, tags-stripped / entity-decoded / trimmed, equals `Code:` (case-insensitive; `Promo Code:`, `Barcode:`, `PIN:` do NOT match). Its value is the text of the FIRST `<span>` inside the label cell itself (same-cell layout), else the first `<span>` of the NEXT leaf cell provided no `</tr>` lies between the two cells (same row only; the first cell of the next row does not count). A next cell with text but no `<span>` yields no value. Span text: tags stripped, entities decoded (`&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;`), whitespace runs collapsed to one space, trimmed; an empty value is no value.
- Collect the DISTINCT values over all label cells (the same code repeated is fine): exactly one -> success; none -> `{ ok: false, reason: 'no-code' }`; more than one distinct -> `{ ok: false, reason: 'ambiguous-code' }`.
- Success: `{ ok: true, index: N, total: M, code }`.
- The code is a SECRET: it appears ONLY in the success result. Failure results contain ONLY `ok` and `reason` and never echo any part of the input. Never log (`console.*`) anything.

## Behaviour that must NOT change

- Nothing else in `sidecar/` changes; do not touch other files. `module.exports` must export exactly `parsePrintPage`.

## Must contain

- `parsePrintPage`
- `module.exports`
- `wdt-page-counter`
- `no-pager`
- `no-code`
- `ambiguous-code`
- `invalid-input`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `sidecar/src/costcoEgiftPrint.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check. All fixtures are SYNTHETIC fake codes; never contact memberedelivery.com.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises.
- Do not add defensive branches or try/catch the fixtures cannot reach.
- If a line cannot be asserted and cannot be folded, restructure so it isn't a separate line.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
