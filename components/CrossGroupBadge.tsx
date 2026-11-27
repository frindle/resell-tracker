'use client';

import { useEffect, useState } from 'react';
import { badgeText, flagKey, GROUP_LABEL, type CrossGroupFlag, type GroupId, type SkippedGroup } from '@/lib/crossGroup';

type Result = { flags: Record<string, CrossGroupFlag>; skipped: SkippedGroup[] };

/** Cross-group flags from the server index (cached ~10 min there). A failure just means no badges. */
export function useCrossGroup(): Result {
  const [res, setRes] = useState<Result>({ flags: {}, skipped: [] });
  useEffect(() => {
    let live = true;
    fetch('/api/cross-group')
      .then(r => (r.ok ? r.json() : null))
      .then((d: Result | null) => { if (live && d?.flags) setRes({ flags: d.flags, skipped: d.skipped ?? [] }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return res;
}

export function CrossGroupBadge({ flags, group, id }: { flags: Record<string, CrossGroupFlag>; group: GroupId; id: string }) {
  const f = flags[flagKey(group, id)];
  if (!f) return null;
  return (
    <a
      href={f.href}
      onClick={e => e.stopPropagation()}
      title={`${GROUP_LABEL[f.group]} pays $${f.payout.toFixed(2)} for ${f.title} (matched by ${f.matchedBy})`}
      className="inline-flex shrink-0 max-w-full px-1.5 py-0.5 rounded text-xs font-medium bg-amber-900/40 text-amber-300 border border-amber-800 hover:bg-amber-900/60 whitespace-nowrap"
    >
      {badgeText(f)} ↗
    </a>
  );
}

export function SkippedNote({ skipped }: { skipped: SkippedGroup[] }) {
  if (!skipped.length) return null;
  return (
    <p className="text-xs text-gray-600">
      Cross-group check skipped: {skipped.map(s => `${GROUP_LABEL[s.group]} (${s.reason})`).join('; ')}
    </p>
  );
}
