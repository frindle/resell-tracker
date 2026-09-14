#!/usr/bin/env python3
"""Reference impl for rt-saved-address-schema: append the SavedAddress model
to prisma/schema.prisma. Edits ONLY the tracked schema file so the preflight
can revert it cleanly (verify_failed_at_baseline stays true)."""
import sys, pathlib
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
schema = wt / "prisma" / "schema.prisma"
text = schema.read_text()
if "model SavedAddress" in text:
    sys.exit(0)
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
