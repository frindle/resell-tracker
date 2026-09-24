#!/usr/bin/env python3
"""Reference impl for: rt-dashboard-pl-unsubmitted-cc

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Change: app/page.tsx's three P&L findMany calls (current_month, current_quarter,
ytd) gain the same unsubmittedCCFilter where-clause that
app/api/analytics/route.ts already applies. Everything else in the file is
preserved verbatim.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/page.tsx'
t = p.read_text()

# 1) Define the filter (mirrored exactly from app/api/analytics/route.ts) just
#    before the page component.
OLD_DEF = r'''export default async function DashboardPage() {
  const userId = await getSessionUserId();'''
NEW_DEF = r'''// Exclude Card Center orders whose gift cards are ALL unsubmitted (every card
// has ccSubmittedAt null), mirroring app/api/analytics/route.ts exactly so the
// dashboard's month/quarter/YTD P&L matches /analytics. `some: {}` guards the
// vacuous-true case so plain non-Card-Center orders are NOT dropped; a
// partially submitted order keeps its P&L because not every card is unsubmitted.
const unsubmittedCCFilter = { NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } };

export default async function DashboardPage() {
  const userId = await getSessionUserId();'''

assert OLD_DEF in t, "refimpl anchor (component head) not found -- did the target change?"
t = t.replace(OLD_DEF, NEW_DEF, 1)

# 2) Apply the filter alongside cancelled/ignoredByRule in each of the three
#    period findMany calls. All three lines share this exact substring; the
#    all-time query (calls[0]) does not carry cancelled:false and is untouched.
OLD_WHERE = r'''cancelled: false, ignoredByRule: false, orderDate:'''
NEW_WHERE = r'''cancelled: false, ignoredByRule: false, ...unsubmittedCCFilter, orderDate:'''

count = t.count(OLD_WHERE)
assert count == 3, f"expected exactly 3 period findMany where-clauses, found {count}"
t = t.replace(OLD_WHERE, NEW_WHERE)

p.write_text(t)
print("refimpl applied")
