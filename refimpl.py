#!/usr/bin/env python3
"""Reference impl for rt-order-buyerid-patchable: add 'buyerId' to
PATCHABLE_FIELDS and a guarded Int/null coercion mirroring cardId. Edits ONLY
the tracked route.ts so preflight reverts it cleanly."""
import sys, pathlib
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
f = wt / "app" / "api" / "orders" / "[id]" / "route.ts"
t = f.read_text()

# 1. membership
if "'buyerId'" not in t:
    t = t.replace("'shippingAddress', 'cardId']);",
                  "'shippingAddress', 'cardId', 'buyerId']);", 1)

# 2. guarded coercion, right after the cardId block
card_block = (
    "  if ('cardId' in data) {\n"
    "    data.cardId = data.cardId == null || data.cardId === '' ? null : parseInt(data.cardId as string);\n"
    "  }\n"
)
buyer_block = (
    "  // buyerId is a Prisma Int? relation (moving an order between Buyer groups) --\n"
    "  // coerce like cardId; guard on `in data` so an unrelated PATCH never unassigns it.\n"
    "  if ('buyerId' in data) {\n"
    "    data.buyerId = data.buyerId == null || data.buyerId === '' ? null : parseInt(data.buyerId as string);\n"
    "  }\n"
)
if "data.buyerId" not in t:
    t = t.replace(card_block, card_block + buyer_block, 1)

f.write_text(t)
print("refimpl: added buyerId membership + guarded coercion")
