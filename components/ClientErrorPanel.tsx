'use client';

import { useEffect } from 'react';

/** Reports a render error to the server once (lib/clientErrorReport.ts) and shows it, with a retry. */
export default function ClientErrorPanel({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: window.location.pathname, message: String(error?.message ?? error), stack: String(error?.stack ?? ''), digest: error?.digest ?? '' }),
    }).catch(() => {});
  }, [error]);
  return (
    <div className="mx-auto max-w-xl rounded border border-red-900 bg-red-950/40 p-4 text-sm">
      <p className="font-medium text-red-300">This page hit an error and was logged.</p>
      <p className="mt-2 break-words font-mono text-xs text-red-200">{String(error?.message ?? error)}</p>
      <button type="button" onClick={() => reset()} className="mt-3 rounded bg-gray-800 px-3 py-1 text-gray-100 hover:bg-gray-700">Try again</button>
    </div>
  );
}
