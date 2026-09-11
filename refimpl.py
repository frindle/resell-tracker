#!/usr/bin/env python3
"""Reference impl for a DIAGNOSIS deliverable: write a structurally-valid
DIAGNOSIS.md so the gate can prove the verify is satisfiable + enforces the
required sections. Content is a placeholder -- the real diagnosis is the model's.
"""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
(wt / "DIAGNOSIS.md").write_text(
    "# Diagnosis: amazon-card-nomatch (reference stub)\n\n"
    "## Root cause\n"
    "Placeholder root cause grounded to a real file at prisma/schema.prisma:1 -- "
    "the last-4 extraction fails to parse Amazon's changed payment format, so the "
    "match that sets order.cardId never fires and the field stays null.\n\n"
    "## Evidence\n"
    "Placeholder: order 917 imported with cardId=null while 24 other recent Amazon "
    "orders matched; the raw payment string is not persisted on the order record.\n\n"
    "## Fix sketch\n"
    "Placeholder: broaden the last-4 extraction to tolerate the new format and "
    "persist the raw scraped payment string on import for future diagnosability.\n\n"
    "## Falsifiable prediction\n"
    "Placeholder: the extraction requires a specific literal token; a payment "
    "string lacking it returns no last-4. Checkable against the code and order 917.\n"
)
print("refimpl applied")
