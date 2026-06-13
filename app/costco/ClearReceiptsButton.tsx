'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ClearReceiptsButton({ count, linkedCount }: { count: number; linkedCount: number }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function clear() {
    if (!confirm(`Delete ${count} unlinked receipt(s)?`)) return;
    setLoading(true);
    await fetch('/api/costco/receipts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    setLoading(false);
    router.refresh();
  }

  async function resetAll() {
    if (!confirm(`This will unlink ${linkedCount} linked receipt(s) and delete all ${count} unlinked ones, so you can re-import with HTML receipts. Continue?`)) return;
    setLoading(true);
    await fetch('/api/costco/receipts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      {count > 0 && (
        <button
          onClick={clear}
          disabled={loading}
          className="text-xs bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
        >
          {loading ? 'Deleting…' : `Clear ${count} unlinked`}
        </button>
      )}
      {linkedCount > 0 && (
        <button
          onClick={resetAll}
          disabled={loading}
          className="text-xs bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
        >
          {loading ? 'Resetting…' : `Reset all (re-import)`}
        </button>
      )}
    </div>
  );
}
