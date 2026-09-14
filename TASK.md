# TASK: rt-order919-address-resync

## Confirmed defect (observed, not suspected)

confirmed: order 919 (orderNumber 111-8410226-7500217) had its Amazon ship-to changed by the user from '13 Fl4gst0ne Dr, Hudson, NH 03051' to '146 R1ver Rhode, new castle, DE 19720'. Live API confirms the tracker's stored shippingAddress is STILL the OLD value after a sync ran (updatedAt=2026-09-14T21:22, userEditedAt=2026-09-14T20:27 SET from an earlier manual card match on the SAME order). Root cause: app/api/import/route.ts line 330 'shippingAddress: existing.shippingAddress || (r.shippingAddress || null)' unconditionally freezes shippingAddress once any non-null value exists, with no per-field distinction from the whole-order userEditedAt set by the unrelated card edit -- so a real Amazon ship-to change never reaches the DB and the buyer/group re-match + recalc never re-fires.

## Entry point

app/api/import/route.ts:330

## Required change

Implement five exported functions in `lib/orderFieldSync.ts` (the test
file `lib/orderFieldSync.test.ts`, which you must NOT edit, imports these
exact names from `./orderFieldSync.ts`):

```ts
export function parseUserEditedFields(raw: string | null | undefined): string[]
// Parses the Order.userEditedFields column (a JSON array of field-name
// strings, e.g. '["cardId","shippingAddress"]'). Returns [] for null,
// undefined, malformed JSON, or JSON that doesn't decode to an array of
// strings -- NEVER throws.

export function mergeUserEditedFields(existingRaw: string | null | undefined, editedKeys: string[]): string
// Called from the PATCH route when the user hand-edits one or more fields.
// Returns the NEW JSON string to store: the union of whatever field names
// were already recorded plus editedKeys, deduped. Editing cardId must NOT
// implicitly add shippingAddress (or any other field) to the set -- record
// only the field(s) actually named in editedKeys.

export interface ResolvedShippingAddress {
  shippingAddress: string | null;
  addressChanged: boolean; // true iff the RESOLVED value differs from what was stored -- this is the signal callers use to re-trigger buyer re-match + recalc
}
export function resolveShippingAddress(
  existingAddress: string | null | undefined,
  incomingAddress: string | null | undefined,
  userEditedFieldsRaw: string | null | undefined,
): ResolvedShippingAddress
// Decides what shippingAddress should be on a sync/import upsert:
// - If "shippingAddress" is present in parseUserEditedFields(userEditedFieldsRaw),
//   the user edited the address by hand -- ALWAYS keep existingAddress,
//   addressChanged: false, regardless of what the scrape brought.
// - Else if incomingAddress is null/empty, keep existingAddress unchanged,
//   addressChanged: false (a scrape that found nothing must never null out
//   a stored address).
// - Else if incomingAddress === (existingAddress ?? null), keep it,
//   addressChanged: false (no needless rewrite / no false re-trigger).
// - Else (not user-edited, and the scrape brought a genuinely different,
//   non-empty value): return { shippingAddress: incomingAddress, addressChanged: true }.
//   THIS is the order-919 case -- a card edit must never freeze the address.

export interface ExistingOrderForSync {
  shippingAddress: string | null;
  buyerId: number | null;
  userEditedFields: string | null;
}
export interface IncomingSyncRow {
  shippingAddress?: string | null;
  buyerId?: string | null;
}
export interface OrderSyncFieldUpdate {
  resolvedShippingAddress: string | null;
  resolvedBuyerId: number | null;
  addressChanged: boolean;
}
export function resolveOrderSyncFields(
  existing: ExistingOrderForSync,
  row: IncomingSyncRow,
  matchBuyerId: (address: string | undefined) => number | null,
): OrderSyncFieldUpdate
// The FULL sync-path decision, built on resolveShippingAddress above. Field
// names are deliberately NOT the same as `existing`'s own field names
// (resolvedShippingAddress/resolvedBuyerId, not shippingAddress/buyerId) --
// keep it that way; do not "simplify" to matching names.
// - Compute addressResolution = resolveShippingAddress(existing.shippingAddress, row.shippingAddress, existing.userEditedFields).
// - If addressResolution.addressChanged is true AND "buyerId" is NOT in
//   parseUserEditedFields(existing.userEditedFields): resolvedBuyerId = matchBuyerId(addressResolution.shippingAddress ?? undefined)
//   -- this is what makes the buyer/group re-match re-fire on a real address
//   change (the order-919 case: card was user-edited, address was not, so
//   this branch fires).
// - Else if existing.buyerId is null: resolvedBuyerId = row.buyerId ? parseInt(row.buyerId, 10) : matchBuyerId(row.shippingAddress ?? existing.shippingAddress ?? undefined)
//   (mirrors the ORIGINAL frozen-until-null behaviour for the ordinary case).
// - Else: resolvedBuyerId = existing.buyerId (a user-assigned or already-resolved buyer stays put).
// - Return { resolvedShippingAddress: addressResolution.shippingAddress, resolvedBuyerId, addressChanged: addressResolution.addressChanged }.
```

`matchBuyerId` is injected (not imported) specifically so this function stays
pure and testable with a stub -- the real route passes its own module-level
`matchBuyerId` (already defined in app/api/import/route.ts).

```ts
export interface PrismaOrderLookupClient {
  order: {
    findUnique: (args: {
      where: { id: number; userId: number | null };
      select: { userEditedFields: true };
    }) => Promise<{ userEditedFields: string | null } | null>;
  };
}
export async function loadAndMergeUserEditedFields(
  prismaClient: PrismaOrderLookupClient,
  orderId: number,
  userId: number | null,
  editedKeys: string[],
): Promise<string>
// Reads prismaClient.order.findUnique({ where: { id: orderId, userId },
// select: { userEditedFields: true } }), then returns
// mergeUserEditedFields(before?.userEditedFields ?? null, editedKeys).
// This is what the PATCH route calls -- centralizing the read+merge here
// (instead of a findUnique + mergeUserEditedFields pair inlined in the
// route) so the route's footprint of this logic is a single call.
// prismaClient is injected (not imported from '@/lib/db') so this is
// testable with a plain stub object instead of a real database.
```

Then wire these into the real routes:

1. **`prisma/schema.prisma`** -- add a nullable `userEditedFields String?` column
   to the `Order` model (JSON-encoded array of field names, mirroring the
   existing `userEditedAt DateTime?` field right above it). Add a matching
   migration under `prisma/migrations/` (a new timestamped directory with a
   `migration.sql` doing `ALTER TABLE "Order" ADD COLUMN "userEditedFields" TEXT;`
   -- follow the naming convention of the existing directories in
   `prisma/migrations/`).

2. **`app/api/orders/[id]/route.ts`** (PATCH handler) -- import
   `loadAndMergeUserEditedFields` from `@/lib/orderFieldSync` (a dynamic
   `await import(...)` inline, or a top-level `import`, either is fine).
   Right after the `data` object is built from `PATCHABLE_FIELDS` (the
   `for (const key of Object.keys(body))` loop), when `patchKeys.length > 0`,
   set `data.userEditedFields` to the (awaited) result of
   `loadAndMergeUserEditedFields(prisma, parseInt(id), userId ?? null, patchKeys)`
   (`prisma` is already imported at the top of this file; `userId` and `id`
   are already in scope in the PATCH handler).

3. **`app/api/import/route.ts`** (the `toUpdate` sync/upsert path) -- select
   `userEditedFields` on `existing`. Replace the existing
   `const resolvedBuyerId = existing.buyerId ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(...))`
   line with a call `resolveOrderSyncFields(existing, r, matchBuyerId)` and
   use its `.resolvedBuyerId` for `resolvedBuyerId` (keep that name -- it is
   already used later in the same update payload) and its
   `.resolvedShippingAddress` for the `shippingAddress:` field, replacing
   `shippingAddress: existing.shippingAddress || (r.shippingAddress || null),`.

Behaviour that must NOT change:
- A user who hand-edits shippingAddress still has that value protected from
  being clobbered by a later scrape (this is the guard's real, legitimate
  purpose -- do not remove it, only make it per-field).
- Editing an unrelated field (e.g. cardId) must never implicitly add
  shippingAddress to the protected set.
- A scrape that finds no address, or the same address, must not rewrite the
  column or spuriously signal `addressChanged`.

## Must contain

- `export function resolveShippingAddress`
- `export function mergeUserEditedFields`
- `export function parseUserEditedFields`
- `export function resolveOrderSyncFields`
- `export async function loadAndMergeUserEditedFields`
- in prisma/schema.prisma: `userEditedFields`
- in app/api/import/route.ts: `resolveOrderSyncFields`
- in app/api/orders/[id]/route.ts: `loadAndMergeUserEditedFields`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/orderFieldSync.ts`, `app/api/import/route.ts`, `app/api/orders/[id]/route.ts`, `prisma/schema.prisma`; do not edit `verify.sh`, `lib/orderFieldSync.test.ts` or `TASK.md`.
lib/orderFieldSync.test.ts is the test fixture -- changing it invalidates the check.

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
