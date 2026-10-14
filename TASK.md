# TASK: egiftRedemption

## Confirmed defect (observed, not suspected)

NEW FEATURE (no defect): the sidecar has no parser for the Costco eGift redemption page (memberedelivery.com /pages/redemption-page.xhtml). `sidecar/src/costcoEgiftRedemption.js` is a stub (`export {};`) at baseline. Verified by reading the file.

## Entry point

sidecar/src/costcoEgiftRedemption.js:1 (replace the stub entirely; CommonJS, `'use strict'`, `module.exports = { parseRedemptionPage }`).

## Required change

Implement `parseRedemptionPage(html, cfg)` for the InComm eGift portals (Costco memberedelivery.com and Best Buy specialtyegc.bestbuy.com share one platform; `cfg` is the per-site config, e.g. Costco `{ openLabel: 'Access eGift', orderPrefix: null }`, Best Buy `{ openLabel: 'View', orderPrefix: 'BBY01-' }`): a PURE function over an HTML string (no require of playwright/fs/net, no I/O, no globals, no new dependencies, NEVER throws). The page is a PrimeFaces/JSF page: `j_idt*` ids are unstable, so match by CLASS TOKEN only, never by id. Input is what `page.content()` returns.

Contract:
- Non-string `html`, or a `cfg` that is missing / not an object / has a non-string `openLabel` -> `{ ok: false, reason: 'invalid-input' }`.
- First remove HTML comments (`<!-- -->`) and `<script>`/`<style>` elements: markup inside them is NOT part of the page.
- A CARD is a `<section>` element whose `class` attribute, split on whitespace, contains the token `order-item` EXACTLY (`reorder-item`, `order-item-extra` are NOT cards). Find sections with a tag scanner that respects quoted attribute values (a `>` inside `data-x="a>b"` does not end the tag) and tracks nested `<section>` depth, so a nested section inside a card does not end it early. Cards are returned in document order.
- Per card (an object with EXACTLY these keys): `index` (number), `title` (string), `canOpen` (boolean).
  - `title`: text of the first element with class token `order-item-title` inside the card: tags stripped, entities decoded (`&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;`), whitespace runs collapsed to one space, trimmed. Missing title -> `''`.
  - `index`: N from the first `N of M` (regex `(\d+)\s+of\s+(\d+)`) found in the card's text AFTER removing the `order-item-title` element and the `order-item-actions` element (a title like "Deal 7 of 9" must not win). No counter -> the card's 1-based position in the page.
  - `canOpen`: true iff inside the element with class token `order-item-actions` there is a control whose label, trimmed and lowercased, equals `cfg.openLabel` trimmed and lowercased (exact equality: `Preview` / `View Terms` are not `View`). Controls are `<button>` and `<a>` (label = their text content, tags stripped) and `<input>` (label = its `value` attribute). `Send Gift` NEVER counts; a matching link elsewhere in the card (outside `order-item-actions`) does NOT count; a title containing the open label does NOT count.
- `orderNumber`: the first `Order Number:\s*([A-Za-z0-9-]+)` match in the page text (whole page, document order); if `cfg.orderPrefix` is set and the match does not start with it, or there is no match, `null`.
- Success: `{ ok: true, orderNumber, total, cards }` where `total` = M from the first counter found (document order), else `cards.length`. A `section.fraud-warning` (or any non-`order-item` section) is never a card.
- No cards found: `{ ok: false, reason: 'alert' }` if the page has a `<div>` whose class tokens include `ui-message` and `role="alert"` with non-empty text, else `{ ok: false, reason: 'no-cards' }`. Failure results contain ONLY `ok` and `reason`: they must never echo any part of the input (the page may carry secrets).
- This function only READS html. It must never produce, contain, or reference any instruction to click `Send Gift`.

## Behaviour that must NOT change

- Nothing else in `sidecar/` changes; do not touch other files. `module.exports` must export exactly `parseRedemptionPage`.

## Must contain

- `parseRedemptionPage`
- `module.exports`
- `order-item-title`
- `order-item-actions`
- `ui-message`
- `invalid-input`
- `no-cards`
- `openLabel`
- `orderPrefix`
- `canOpen`
- `orderNumber`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `sidecar/src/costcoEgiftRedemption.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check. All fixtures are SYNTHETIC; never contact memberedelivery.com.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises.
- Prefer falling through to an implicit `return` over a standalone untested
  `return` in a `catch`; do not add defensive branches the fixtures cannot reach.
- If a line genuinely cannot be asserted and cannot be folded, restructure so it isn't a separate line.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
