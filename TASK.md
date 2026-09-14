# TASK: rt-order-buyerid-patchable

## Confirmed defect (observed, not suspected)

Confirmed by inspection of `app/api/orders/[id]/route.ts`: the PATCH handler's
`PATCHABLE_FIELDS` Set (:191) lists `'cardId'` but NOT `'buyerId'`. The handler
filters the request body through that Set (:226-228:
`for (const key ...) if (PATCHABLE_FIELDS.has(key)) data[key] = body[key];`),
so a PATCH that sends `buyerId` (moving an order between Buyer groups) is
silently dropped -- `prisma.order.update` never receives it and the move does
not persist. Re-sync survival of an assigned buyer is already handled in
`app/api/import/route.ts:320-321` (`existing.buyerId ?? ...`); this task only
fixes the PATCH persistence gap.

## Entry point

`app/api/orders/[id]/route.ts:191` -- the `PATCHABLE_FIELDS = new Set([...])`
declaration, plus the coercion block right after it at :232-236.

## Required change

Two edits in `app/api/orders/[id]/route.ts`, nothing else:

1. Add `'buyerId'` to the `PATCHABLE_FIELDS` Set so it survives the filter into
   `data`.
2. `buyerId` is a Prisma `Int?` relation (Order.buyerId, schema :95), exactly
   like `cardId`. Add a coercion block mirroring the existing cardId one
   (:234-236) so a numeric string becomes an int and null/'' becomes an
   unassign, and the raw body value never reaches Prisma as a string. It MUST
   be guarded by `if ('buyerId' in data)` so a PATCH that does not send buyerId
   is left untouched (an unguarded assignment would unassign the buyer on every
   unrelated PATCH):

   ```
   if ('buyerId' in data) {
     data.buyerId = data.buyerId == null || data.buyerId === '' ? null : parseInt(data.buyerId as string);
   }
   ```

Behaviour that must NOT change:
- `cardId` stays patchable and stays coerced (regression).
- Only `buyerId` is added -- do not blanket-allow other fields.
- A PATCH WITHOUT buyerId must not touch buyerId (the `in data` guard).

Follow-up (OUT OF SCOPE here, do NOT do it): the Amazon auto-order design also
calls for re-verifying the shipping address when an order moves buyers. Leave
that for a separate dispatch; this job is buyerId persistence only.

## Must contain

- `'buyerId'`
- `data.buyerId`
- `parseInt`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed file, the verify does not enforce
the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `app/api/orders/[id]/route.ts`. Do NOT edit `verify.sh`,
`verify_impl.mjs`, `check_literals.py` or `TASK.md`.

## Keep every changed line exercised (relevance)

`verify_impl.mjs` evaluates the REAL PATCHABLE_FIELDS Set and the REAL guarded
coercion block from your edited source: membership, the filter loop, the
'7'->7 / ''->null / null->null coercions, and the absent-buyerId guard case.
Keep the coercion on the same shape as cardId (attributes/logic on the same
line) so no mutated line survives untested.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
