#!/usr/bin/env python3
"""Reference impl for: rt-order919-address-resync

The gate applies this, runs the verify, and reverts it.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# 1) lib/orderFieldSync.ts -- body kept outside the worktree, copied in.
BODY_SRC = pathlib.Path(
    "/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/"
    "25809008-b52f-4110-a02e-82f6c315e9aa/scratchpad/orderFieldSync_body.ts"
)
(wt / "lib/orderFieldSync.ts").write_text(BODY_SRC.read_text())

# 2) prisma/schema.prisma -- add the nullable JSON-array column next to
#    userEditedAt, plus a matching migration.
schema_p = wt / "prisma/schema.prisma"
schema_t = schema_p.read_text()
OLD_SCHEMA = "  userEditedAt     DateTime?\n"
assert OLD_SCHEMA in schema_t, "refimpl anchor not found in schema.prisma"
NEW_SCHEMA = (
    OLD_SCHEMA
    + "  // Per-field companion to userEditedAt: JSON array of field names the\n"
    + "  // user has hand-edited, so the import/sync path can protect only\n"
    + "  // those fields instead of freezing the whole order.\n"
    + "  userEditedFields String?\n"
)
schema_p.write_text(schema_t.replace(OLD_SCHEMA, NEW_SCHEMA, 1))

migration_dir = wt / "prisma/migrations/20260914000000_add_order_user_edited_fields"
migration_dir.mkdir(parents=True, exist_ok=True)
(migration_dir / "migration.sql").write_text(
    'ALTER TABLE "Order" ADD COLUMN "userEditedFields" TEXT;\n'
)

# 3) app/api/orders/[id]/route.ts -- PATCH records per-field edits.
patch_p = wt / "app/api/orders/[id]/route.ts"
patch_t = patch_p.read_text()

OLD_IMPORT = "import { requireOrderUnlocked } from '@/lib/orderLock';\n"
assert OLD_IMPORT in patch_t, "refimpl anchor not found (import) in orders/[id]/route.ts"
patch_t = patch_t.replace(
    OLD_IMPORT,
    OLD_IMPORT + "import { mergeUserEditedFields } from '@/lib/orderFieldSync';\n",
    1,
)

OLD_PATCHKEYS = "  const patchKeys = Object.keys(body).filter(k => PATCHABLE_FIELDS.has(k));\n"
assert OLD_PATCHKEYS in patch_t, "refimpl anchor not found (patchKeys) in orders/[id]/route.ts"
NEW_PATCHKEYS = (
    OLD_PATCHKEYS
    + "  const beforeEdit = await prisma.order.findUnique({\n"
    + "    where: { id: parseInt(id), userId: userId ?? null },\n"
    + "    select: { userEditedFields: true },\n"
    + "  });\n"
)
patch_t = patch_t.replace(OLD_PATCHKEYS, NEW_PATCHKEYS, 1)

OLD_DATA_BUILD = (
    "  const data: Record<string, unknown> = {};\n"
    "  for (const key of Object.keys(body)) {\n"
    "    if (PATCHABLE_FIELDS.has(key)) data[key] = body[key];\n"
    "  }\n"
)
assert OLD_DATA_BUILD in patch_t, "refimpl anchor not found (data build) in orders/[id]/route.ts"
NEW_DATA_BUILD = (
    OLD_DATA_BUILD
    + "  if (patchKeys.length > 0) {\n"
    + "    data.userEditedFields = mergeUserEditedFields(beforeEdit?.userEditedFields, patchKeys);\n"
    + "  }\n"
)
patch_t = patch_t.replace(OLD_DATA_BUILD, NEW_DATA_BUILD, 1)
patch_p.write_text(patch_t)

# 4) app/api/import/route.ts -- sync path updates shippingAddress per-field
#    and re-triggers buyer resolution when it changes.
import_p = wt / "app/api/import/route.ts"
import_t = import_p.read_text()

OLD_IMPORT_IMPORT = "import { computeCashback } from '@/lib/cashback';\n"
assert OLD_IMPORT_IMPORT in import_t, "refimpl anchor not found (import) in import/route.ts"
import_t = import_t.replace(
    OLD_IMPORT_IMPORT,
    OLD_IMPORT_IMPORT + "import { resolveShippingAddress } from '@/lib/orderFieldSync';\n",
    1,
)

OLD_BUYER_LINE = (
    "        const resolvedBuyerId = existing.buyerId\n"
    "          ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress ?? existing.shippingAddress ?? undefined));\n"
)
assert OLD_BUYER_LINE in import_t, "refimpl anchor not found (buyerId) in import/route.ts"
NEW_BUYER_LINE = (
    "        const addressResolution = resolveShippingAddress(existing.shippingAddress, r.shippingAddress, existing.userEditedFields);\n"
    "        const userEditedFieldsList = existing.userEditedFields ? (JSON.parse(existing.userEditedFields) as string[]) : [];\n"
    "        const resolvedBuyerId = (addressResolution.addressChanged && !userEditedFieldsList.includes('buyerId'))\n"
    "          ? matchBuyerId(addressResolution.shippingAddress ?? undefined)\n"
    "          : existing.buyerId ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress ?? existing.shippingAddress ?? undefined));\n"
)
import_t = import_t.replace(OLD_BUYER_LINE, NEW_BUYER_LINE, 1)

OLD_ADDR_LINE = "            shippingAddress: existing.shippingAddress || (r.shippingAddress || null),\n"
assert OLD_ADDR_LINE in import_t, "refimpl anchor not found (shippingAddress) in import/route.ts"
NEW_ADDR_LINE = "            shippingAddress: addressResolution.shippingAddress,\n"
import_t = import_t.replace(OLD_ADDR_LINE, NEW_ADDR_LINE, 1)

OLD_SELECT = "      shippingAddress: true,\n"
assert OLD_SELECT in import_t, "refimpl anchor not found (select) in import/route.ts"
import_t = import_t.replace(
    OLD_SELECT,
    OLD_SELECT + "      userEditedFields: true,\n",
    1,
)

import_p.write_text(import_t)

print("refimpl applied")
