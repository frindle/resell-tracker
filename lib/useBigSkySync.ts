'use client';

import { useState } from 'react';
import { parseSyncReply, syncMessage } from '@/lib/bigskySyncResult';

/**
 * The "Sync from BigSky" action shared by /bigsky and the order page. The
 * request returns when the sync is done, so `syncing` covers the whole run.
 * `onDone` runs afterwards (success or not) so the caller can reload its list.
 */
export function useBigSkySync(onDone: () => Promise<void> | void) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bigsky/sync-commitments', { method: 'POST' });
      setMessage(syncMessage(parseSyncReply(res.status, await res.text())));
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    }
    try {
      await onDone();
    } finally {
      setSyncing(false);
    }
  }

  return { syncing, message, sync };
}
