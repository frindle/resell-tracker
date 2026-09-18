# TASK: sync-status-drag-resize

## Confirmed defect (observed, not suspected)

Confirmed via code read + a static CSS repro harness (Playwright, computed getBoundingClientRect): the panel is position:fixed with Tailwind bottom-4/right-4 (bottom:1rem; right:1rem) baked into className, and NO explicit height. When the user drags the panel (or a saved position is restored from localStorage), handleMouseDown/handleMouseMove set React state 'position' {x,y}, and the JSX applies style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}. This sets top+left via inline style while leaving bottom-4/right-4 (bottom+right) ALSO in effect from the className. A position:fixed box with top, left, right, AND bottom all non-auto and no explicit height has its height computed by the browser as the span between top and bottom (CSS2.1 10.6.5), not by its content. Repro measured: dragging to top:1000px on a 1117px-tall viewport (bottom stays anchored at 16px from viewport bottom) forces box height to 117px while the 5 sync rows need 164px -- content overflows 47px past the rounded border (matches Penn's screenshot: rows clipped/spilling past the bottom edge). The same mechanism explains the reported 'dragging stretches/resizes the box instead of moving it': as top changes during a drag, height is recomputed from the top-bottom span every frame (grows/shrinks) instead of translating a fixed-size box.

## Entry point

components/SyncStatusIndicator.tsx:216 (the `style={position ? { left: ..., top: ... } : undefined}`
ternary on the panel's root `<div>`) and components/SyncStatusIndicator.tsx:234 (the
`<ul className="divide-y divide-gray-800">` that lists the sync rows).

## Required change

1) Dragging must MOVE the whole panel as a fixed-size unit, never stretch/resize it. Today,
   once `position` state is set (during a drag, or restored from localStorage on load), the
   JSX applies `style={{ left: \`${position.x}px\`, top: \`${position.y}px\` }}` -- but the
   panel's className ALSO carries Tailwind `bottom-4 right-4` (bottom:1rem; right:1rem), which
   inline style does not clear. A `position: fixed` box with top, left, right, AND bottom all
   non-auto and no explicit height gets its height computed by the browser as the span between
   top and bottom, not by its content -- which is why dragging visibly stretches/shrinks the box
   instead of translating it. Fix: when `position` is set, the inline style object must ALSO
   set `right: 'auto'` and `bottom: 'auto'` (exactly those keys, single-quoted `'auto'` string
   values, matching this file's existing single-quote convention for string literals) alongside
   `left`/`top`, so only top+left govern placement and the box's own width/height (from its
   own content and Tailwind classes) are never re-derived from a top-bottom span.
2) With N queued/syncing merchant rows, all N rows must render fully inside the box with no
   content extending past the rounded container border. Add a capped max-height with internal
   scrolling to the `<ul>` that lists the rows: add `max-h-96 overflow-y-auto` to its
   className (alongside the existing `divide-y divide-gray-800`), so a long queue scrolls
   internally instead of spilling past the border.

Behaviour that must NOT change:
- When `position` is null (no drag yet, nothing saved in localStorage), `style` must still be
  `undefined` (the ternary's false branch is unchanged) -- the panel keeps using the Tailwind
  `bottom-4 right-4` default placement until the user first drags it.
- `left` and `top` must still be computed from `position.x` / `position.y` in px exactly as
  before (`` `${position.x}px` `` / `` `${position.y}px` ``) -- only right/bottom are added,
  nothing about left/top's own values changes.
- The `<ul>` keeps its existing `divide-y divide-gray-800` classes and all existing row
  content/markup -- this is an additive className change, not a restructuring of the list.

## Must contain

- `right: 'auto'`
- `bottom: 'auto'`
- `overflow-y-auto`
- `max-h-`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `components/SyncStatusIndicator.tsx`; do not edit `verify.sh`, `verify_impl.mjs` or `TASK.md`.
verify_impl.mjs is the test fixture -- changing it invalidates the check.

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
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
