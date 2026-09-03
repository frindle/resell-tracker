'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  commandLabel,
  isActiveCommand,
  isFinishedCommand,
  isSessionExpiredResult,
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
  const [sidecarInfo, setSidecarInfo] = useState<{ novncPath: string; port: number } | null>(null);
  const [sidecarNeedsSetup, setSidecarNeedsSetup] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then((s: Record<string, string>) => {
      setSidecarNeedsSetup(!s.vnc_password);
    }).catch(() => {});
    fetch('/api/sidecar/info').then(r => r.json()).then(setSidecarInfo).catch(() => {});
  }, []);

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

  // Handle drag events
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!panelRef.current) return;
    
    // Only allow dragging from the header area
    const header = panelRef.current.querySelector('div.flex.items-center.justify-between');
    if (e.target !== header && !header?.contains(e.target as Node)) return;
    
    setIsDragging(true);
    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !panelRef.current) return;
    
    // Calculate new position, constrained to viewport
    let newX = e.clientX - dragOffset.x;
    let newY = e.clientY - dragOffset.y;
    
    // Constrain to viewport boundaries
    const panelRect = panelRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - panelRect.width;
    const maxY = window.innerHeight - panelRect.height;
    
    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));
    
    setPosition({ x: newX, y: newY });
  }, [isDragging, dragOffset]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Initialize position from localStorage or default
  useEffect(() => {
    const savedPosition = localStorage.getItem('syncStatusPosition');
    if (savedPosition) {
      try {
        const pos = JSON.parse(savedPosition);
        setPosition(pos);
      } catch {
        // Use defaults on parse error
      }
    }
  }, []);

  // Save position to localStorage when it changes
  useEffect(() => {
    if (position) {
      localStorage.setItem('syncStatusPosition', JSON.stringify(position));
    }
  }, [position]);

  // Every hook above must run unconditionally on each render (React Rules of Hooks).
  // This early return was previously ABOVE these hooks, so an empty `shown` skipped
  // them and flipped the hook count between renders -> React #310 crash. Bail out of
  // RENDERING only, here, after all hooks have run.
  if (shown.length === 0) return null;

  return (
    <div
      ref={panelRef}
      role="status"
      aria-live="polite"
      aria-label="Sync status"
      className="fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700 bg-gray-900/95 shadow-lg backdrop-blur-sm cursor-move"
      style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}
      onMouseDown={handleMouseDown}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="text-xs uppercase tracking-wide text-gray-500">Sync status</span>
        <button
          onClick={() => {
            // Dismiss ALL currently shown commands (active, queued, running, finished)
            // to allow the panel to close even when a command is stuck in a non-finished state
            setDismissed(prev => new Set([...prev, ...shown.map(c => c.id)]));
          }}
          disabled={false}
          title="Dismiss"
          className="text-gray-600 hover:text-gray-300 transition-colors text-sm leading-none px-1"
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
              {c.status === 'failed' && isSessionExpiredResult(c.result) && (
                sidecarNeedsSetup ? (
                  <a href="/settings" className="block text-xs pl-4 text-blue-400 hover:text-blue-300 underline">
                    Set up sidecar in Settings to fix this →
                  </a>
                ) : sidecarInfo ? (
                  <a
                    href={`/vnc/vnc.html?autoconnect=true&resize=scale`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs pl-4 text-blue-400 hover:text-blue-300 underline"
                  >
                    Login page is already open — connect to sidecar →
                  </a>
                ) : null
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
