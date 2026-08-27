'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  commandLabel,
  isActiveCommand,
  isFinishedCommand,
  relativeTime,
  summarizeResult,
  visibleCommands,
  STATUS_WORD,
  type ExtCommand,
} from '@/lib/syncStatus';

// A finished command stays on screen briefly so a sync that lands while you're
// looking elsewhere doesn't vanish before you see how it went.
const KEEP_FINISHED_MS = 3 * 60 * 1000;
const POLL_ACTIVE_MS = 5_000;    // something is queued or running
const POLL_IDLE_MS = 30_000;

/**
 * Live sync status, bottom-right.
 *
 * The corner banner Penn remembers was never part of this app: it was drawn by
 * the browser extension's tracker-status content script, from outside the page
 * (f0061ad moved it inline into the `data-rt-sync-target` mount point on the
 * orders page). It went quiet because the extension stopped being what runs
 * the Amazon/Walmart/Costco syncs — the headless sidecar does — and the
 * sidecar has no way to draw into the page. So this reads the state the app
 * already owns instead.
 *
 * That state is the ExtensionCommand queue, which is still the real transport:
 * pressing Sync Amazon POSTs a row to /api/extension/commands, and whichever
 * worker polls first (the sidecar, or a browser extension if one is still
 * installed) claims it, sets running, then done or failed with a result blob.
 * `claimedBy` records which one, so this shows it rather than asserting.
 *
 * Everything here is a real transition of that row. There is no spinner that
 * runs on a timer of its own: if the queue says pending, this says queued, and
 * it will sit there saying queued for as long as the row does.
 */

const DOT: Record<string, string> = {
  pending: 'bg-yellow-400',
  running: 'bg-blue-400',
  done: 'bg-green-400',
  failed: 'bg-red-400',
};

const TEXT: Record<string, string> = {
  pending: 'text-yellow-300',
  running: 'text-blue-300',
  done: 'text-green-300',
  failed: 'text-red-300',
};

export default function SyncStatusIndicator() {
  const [commands, setCommands] = useState<ExtCommand[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const load = useCallback(async (): Promise<ExtCommand[]> => {
    const res = await fetch('/api/extension/commands?all=1', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows: ExtCommand[] = await res.json();
    setCommands(rows);
    return rows;
  }, []);

  useEffect(() => {
    stopped.current = false;

    // A self-rescheduling timeout rather than an interval, so the poll can
    // tighten to 5s while a sync is in flight and fall back to 30s when the
    // queue is quiet. A failed poll doesn't stop the loop -- the tracker
    // being briefly unreachable is not a reason to go permanently blind.
    const tick = async () => {
      if (stopped.current) return;
      let wait = POLL_IDLE_MS;
      if (typeof document !== 'undefined' && document.hidden) {
        wait = POLL_IDLE_MS;
      } else {
        try {
          const rows = await load();
          wait = rows.some(isActiveCommand) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        } catch {
          wait = POLL_IDLE_MS;
        }
      }
      setNow(Date.now());
      if (!stopped.current) timer.current = setTimeout(tick, wait);
    };
    void tick();

    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        if (timer.current) clearTimeout(timer.current);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const active = commands.filter(isActiveCommand);
  const shown = visibleCommands(commands, { now, dismissed, keepFinishedMs: KEEP_FINISHED_MS });

  if (shown.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Sync status"
      className="fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700 bg-gray-900/95 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs uppercase tracking-wide text-gray-500">Sync status</span>
        <button
          onClick={() => setDismissed(prev => new Set([...prev, ...shown.filter(isFinishedCommand).map(c => c.id)]))}
          disabled={active.length > 0}
          title={active.length > 0 ? 'A sync is still running' : 'Dismiss'}
          className="text-gray-600 hover:text-gray-300 disabled:opacity-30 disabled:hover:text-gray-600 transition-colors text-sm leading-none px-1"
        >
          ×
        </button>
      </div>
      <ul className="divide-y divide-gray-800">
        {shown.map(c => {
          const summary = summarizeResult(c.result);
          return (
            <li key={c.id} className="px-3 py-2 space-y-0.5">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[c.status] ?? 'bg-gray-500'} ${isActiveCommand(c) ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                <span className="text-sm text-gray-200 truncate">{commandLabel(c.type)}</span>
                <span className={`text-xs ml-auto shrink-0 ${TEXT[c.status] ?? 'text-gray-400'}`}>
                  {STATUS_WORD[c.status] ?? c.status}
                </span>
              </div>
              {summary && (
                <p className={`text-xs pl-4 break-words ${c.status === 'failed' ? 'text-red-400/80' : 'text-gray-500'}`}>{summary}</p>
              )}
              <p className="text-xs pl-4 text-gray-600">
                {relativeTime(c.createdAt, now)}
                {c.claimedBy ? ` · ${c.claimedBy}` : c.status === 'pending' ? ' · waiting for a worker' : ''}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
