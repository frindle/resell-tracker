# TASK: rt-saved-address-schema

## Confirmed defect (observed, not suspected)

Confirmed by inspection: `prisma/schema.prisma` has NO `SavedAddress` model
(`grep -rn SavedAddress prisma/ app/ lib/` returns nothing on the baseline).
The BFMR group->address matching flow (imported retailer shipping addresses)
therefore has nowhere to persist a saved address, so a matchable address key
cannot be stored or looked up.

## Entry point

`prisma/schema.prisma` -- add a new top-level `model SavedAddress { ... }`.
Insert it near the other reference models (e.g. after `model Buyer` at :74 or
at end of file). Do not modify any existing model.

## Required change

Add a `SavedAddress` Prisma model. Follow the existing schema conventions
(see `CreditCard` :35 which uses `last4 String?`, `Buyer` :74, `ShippingRule`
:89): integer autoincrement PK, `String?` for optional scalars, `DateTime`
timestamps with `@default(now())` / `@updatedAt`.

Fields (at minimum):
- `id        Int      @id @default(autoincrement())`
- `retailer  String`   -- Amazon | Walmart | Costco | ... (which retailer this address came from)
- `addressKey String  @unique`  -- the NORMALIZED address key used for group->address matching; unique so it can be upserted/looked-up by key
- `name      String?`
- `line1     String?`  -- raw address line 1
- `line2     String?`  -- raw address line 2 (optional)
- `city      String?`
- `state     String?`
- `zip       String?`
- `country   String?`
- `createdAt DateTime @default(now())`
- `updatedAt DateTime @updatedAt`

Then create the migration: add a new migration directory
`prisma/migrations/<UTC-timestamp>_add_saved_address/migration.sql` following the
repo convention (see the existing dated dirs under `prisma/migrations/`) whose
SQL is `CREATE TABLE "SavedAddress" (...)`.

CRITICAL -- the migration SQL must be VALID SQLite and is now MACHINE-GATED:
- Express the `addressKey` uniqueness as a SEPARATE statement AFTER the table:
  `CREATE UNIQUE INDEX "SavedAddress_addressKey_key" ON "SavedAddress"("addressKey");`
- Do NOT put a `UNIQUE INDEX ... (...)` clause INSIDE the `CREATE TABLE(...)`
  body -- SQLite rejects it with `Parse error near "INDEX"`. (The prior dispatch
  shipped exactly that; `prisma validate` did not catch it because it gates the
  schema, not the migration.)
- verify.sh now applies the WHOLE migration chain (including yours) to a throwaway
  sqlite database and FAILS on any error, and requires the separate
  `CREATE UNIQUE INDEX`. The migration is a gated deliverable, not a
  reviewer-only artifact.

Behaviour that must NOT change:
- No existing model is edited; `prisma validate` must still pass for the whole
  schema (a malformed new model would make it fail).

## Must contain

- `model SavedAddress`
- `retailer`
- `addressKey`
- `@unique`
- `line1`
- `updatedAt`
- `@updatedAt`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed file, the verify does not enforce
the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `prisma/schema.prisma` and create the new
`prisma/migrations/<timestamp>_add_saved_address/migration.sql` file. Do NOT
edit `verify.sh`, `check_literals.py` or `TASK.md`.

## Keep every changed line exercised (relevance)

Every field named above is asserted INSIDE the `model SavedAddress { ... }`
block by `verify.sh`, and `prisma validate` gates well-formedness. Do not add a
stray unrelated line. Put attributes (`@unique`, `@default(now())`,
`@updatedAt`) on the SAME line as the field they modify -- that is how Prisma
schema is written and how the verify checks them.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
