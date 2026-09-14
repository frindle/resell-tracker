# TASK: sync-status-overflow

## Confirmed defect (observed, not suspected)

Confirmed via Penn screenshot: the floating Sync status panel (bottom-right,
`w-72` rounded box in `components/SyncStatusIndicator.tsx`) overflows -- the
per-job header row text spills outside the rounded border.

Reproduced in code: the label span that renders `commandLabel(c.type)` (line
244) has `truncate` but no `min-w-0`. It sits in a flex row
(`<div className="flex items-center gap-2">`). A flex item defaults to
`min-width: auto`, so it will NOT shrink below its content width; `truncate`
(which is `overflow-hidden text-ellipsis whitespace-nowrap`) therefore never
takes effect. A long label -- e.g. `commandLabel`'s raw-type fallback for an
unknown command type -- keeps its full width and pushes the `ml-auto` status
word past the container edge, spilling outside the box.

## Entry point

`components/SyncStatusIndicator.tsx:244` -- the single line:
`<span className="text-sm text-gray-200 truncate">{commandLabel(c.type)}</span>`

## Required change

Add `min-w-0` to that label span's className so the flex child can shrink and
`truncate` ellipsizes within the box. The span must carry BOTH `min-w-0` and
`truncate`. This is the standard Tailwind flex-truncation pattern; it is a
one-line className change.

Behaviour that must NOT change:
- The label span must still be a `<span>` whose className directly wraps
  `{commandLabel(c.type)}`, still inside the `flex items-center gap-2` header row.
- It must KEEP `truncate` (do not swap `truncate` for `min-w-0`).
- The status-word span must KEEP `text-xs ml-auto shrink-0` -- do not make room
  by letting the status word shrink or wrap; the label truncates, the status
  stays fixed-width and right-aligned.
- Do not restyle the panel, change colors, spacing, width, or any other element.

## Must contain

- `min-w-0`
- `truncate`

## Scope

Only edit `components/SyncStatusIndicator.tsx`; do not edit `verify.sh`,
`verify_impl.mjs` or `TASK.md`. verify_impl.mjs is the test fixture --
changing it invalidates the check.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
