# TASK: egiftPrint

## Confirmed defect (observed, not suspected)

NEW FEATURE (no defect): the sidecar has no parser for the Costco eGift print page (memberedelivery.com /pages/print-page.xhtml). `sidecar/src/costcoEgiftPrint.js` is a stub (`export {};`) at baseline. Verified by reading the file.

## Entry point

sidecar/src/costcoEgiftPrint.js:1 (replace the stub entirely; CommonJS, `'use strict'`, `module.exports = { parsePrintPage }`).

## Required change

Implement `parsePrintPage(html, cfg)` for the InComm eGift print page (Costco memberedelivery.com and Best Buy specialtyegc.bestbuy.com share one platform). `cfg` is the per-site config: Costco `{ code: 'Code:', pin: null }`, Best Buy `{ code: 'Card Number:', pin: 'PIN:' }`. A PURE function over the HTML string `page.content()` returns on the print page: no require of playwright/fs/net, no I/O, no new dependencies, NEVER throws, never `console.*`. The page is JSF (`j_idt*` ids unstable) and the card body is an email-style NESTED template (Costco: nested tables with a label cell; Best Buy: nested divs), so values have no id: locate by LABEL TEXT.

Contract:
- `html` not a string, or `cfg` missing/not an object/with a non-string `cfg.code` -> `{ ok: false, reason: 'invalid-input' }`.
- First remove HTML comments and `<script>`/`<style>` elements: markup inside them is not part of the page.
- PAGER: the element with `id="wdt-page-counter"` (any tag/attribute order, single or double quotes). Its text, trimmed, must match `^(\d+)\s+of\s+(\d+)$` with `1 <= N <= M`; otherwise -> `{ ok: false, reason: 'no-pager' }`. Counters elsewhere ("Page 9 of 99") are ignored. `hasNext` = the page contains an `<input>` whose `id` attribute ENDS with `wdt-nav-next` (the portal REMOVES the Next input on the last card).
- BLOCKS: consider only LEAF blocks: `<td>`, `<th>`, `<div>`, `<p>` elements containing no nested `td|th|table|tr|div|p` tag (outer wrappers contain everything).
- FIELD LOOKUP for a label L (with a flag `plain`): a block matches when its text (tags stripped, entities decoded `&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;`, whitespace runs collapsed to one space, trimmed) STARTS WITH L, case-insensitively, at position 0 (`Promo Code:`, `Barcode:`, `PIN:` do not match L=`Code:`). Let `rest` = the block text after L, trimmed. The value is, in order: (1) the text of the FIRST `<span>` inside the matching block; (2) if the block is a td/th and `rest` is empty: the text of the first `<span>` of the NEXT leaf block, provided that block is also a td/th and no `</tr>` lies between the two (same row only); (3) only when `plain` is true: `rest` itself. Span text is tags-stripped, entity-decoded, whitespace-collapsed, trimmed. Empty values do not count. The set of DISTINCT values over all matching blocks is the result (the same value repeated is fine).
- CODE = FIELD LOOKUP of `cfg.code` with plain=false: exactly one distinct value -> ok; none -> `{ ok: false, reason: 'no-code' }`; more than one -> `{ ok: false, reason: 'ambiguous-code' }`.
- PIN: only if `cfg.pin` is a string (then required): FIELD LOOKUP of `cfg.pin` with plain=true: none -> `{ ok: false, reason: 'no-pin' }`; more than one distinct -> `{ ok: false, reason: 'ambiguous-pin' }`. If `cfg.pin` is null the result `pin` is `null`. Check the code first, then the pin.
- TITLE: the text of the FIRST `<h2>` element appearing after the element with `id="print-content-section"` begins (structural: never match by its inline `style`; an `<h2>` before that element is ignored): tags stripped, entities decoded, whitespace collapsed, trimmed; `''` when there is none. Merchant/value are NOT parsed here (the tracker's lib parses the title).
- Success: `{ ok: true, index: N, total: M, done, code, pin, title }` where `done` is `true` iff `N === M` OR `hasNext` is false (stop condition of the scraper loop; either signal alone stops it).
- The code and PIN are SECRETS: they appear ONLY in the success result. Failure results contain ONLY `ok` and `reason` and never echo any part of the input.

## Behaviour that must NOT change

- Nothing else in `sidecar/` changes; do not touch other files. `module.exports` must export exactly `parsePrintPage`.

## Must contain

- `parsePrintPage`
- `module.exports`
- `wdt-page-counter`
- `no-pager`
- `no-code`
- `no-pin`
- `ambiguous-pin`
- `wdt-nav-next`
- `print-content-section`
- `title`
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
