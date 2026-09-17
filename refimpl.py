#!/usr/bin/env python3
"""Reference impl for rt-saved-address-schema.

Two deliverables, both now MACHINE-GATED by verify.sh:
  1. append the `SavedAddress` model to prisma/schema.prisma (tracked edit), and
  2. create a NEW migration whose SQL is VALID SQLite -- the addressKey
     uniqueness is a SEPARATE `CREATE UNIQUE INDEX` statement, NOT an inline
     `UNIQUE INDEX (...)` inside `CREATE TABLE(...)` (which is a SQLite parse
     error -- exactly the defect the first dispatch shipped past a schema-only
     gate).

The migration is created UNTRACKED; the preflight's revert_refimpl removes the
files it added (dir included), so verify_failed_at_baseline stays true."""
import sys
import pathlib

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# --- 1. schema model ------------------------------------------------------
schema = wt / "prisma" / "schema.prisma"
text = schema.read_text()
if "model SavedAddress" not in text:
    model = '''
model SavedAddress {
  id         Int      @id @default(autoincrement())
  retailer   String   // Amazon | Walmart | Costco | ... -- which retailer this address came from
  addressKey String   @unique // normalized address key for group->address matching
  name       String?
  line1      String?  // raw address line 1
  line2      String?  // raw address line 2
  city       String?
  state      String?
  zip        String?
  country    String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
'''
    if not text.endswith("\n"):
        text += "\n"
    schema.write_text(text + model)
    print("refimpl: appended SavedAddress model")

# --- 2. migration (VALID SQLite: separate CREATE UNIQUE INDEX) ------------
migdir = wt / "prisma" / "migrations" / "20260917000000_add_saved_address"
migdir.mkdir(parents=True, exist_ok=True)
migration = '''\
-- SavedAddress: persisted retailer shipping addresses for BFMR group->address
-- matching. `addressKey` is the normalized address key; unique so it can be
-- upserted/looked-up by key.

-- CreateTable
CREATE TABLE "SavedAddress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "retailer" TEXT NOT NULL,
    "addressKey" TEXT NOT NULL,
    "name" TEXT,
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedAddress_addressKey_key" ON "SavedAddress"("addressKey");
'''
(migdir / "migration.sql").write_text(migration)
print("refimpl: wrote migration 20260917000000_add_saved_address/migration.sql")
