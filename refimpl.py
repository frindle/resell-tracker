#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-pending-sync-scope-s2-export-function-parsebfm

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

The target file currently holds only the placeholder stub, so this writes the
complete module. The emitted TS block is a RAW string: any backslash sequence
in it stays two literal characters instead of becoming an escape.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrSyncScope.ts'
p.parent.mkdir(parents=True, exist_ok=True)

NEW = r'''/**
 * Sync scope for the BFMR pending-sync flow.
 *
 * "all" pulls every reservation from BFMR; "pending" restricts the pull to
 * reservations still awaiting sync. The raw value arrives untrusted (query
 * string / localStorage), so callers must go through parseBfmrSyncScope and
 * never trust a bare string.
 */

export type BfmrSyncScope = 'all' | 'pending';

/** Canonical scope values, in display order. */
export const BFMR_SYNC_SCOPES: readonly BfmrSyncScope[] = ['all', 'pending'];

/** Default when the raw value is absent or unrecognised. */
const DEFAULT_BFMR_SYNC_SCOPE: BfmrSyncScope = 'all';

/**
 * Coerce an unknown raw value into a valid BfmrSyncScope.
 *
 * Accepts exactly the two canonical strings, case-sensitively and without
 * trimming; anything else (null, undefined, numbers, objects, arrays, empty
 * or padded/case-variant strings) falls back to the default 'all'. Never
 * throws: this runs on untrusted input at module boundaries.
 */
export function parseBfmrSyncScope(raw: unknown): BfmrSyncScope {
  if (raw === 'all' || raw === 'pending') return raw;
  return DEFAULT_BFMR_SYNC_SCOPE;
}
'''

p.write_text(NEW)
print("refimpl applied")
