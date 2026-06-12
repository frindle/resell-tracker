'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ClearReceiptsButton({ count }: { count: number }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function clear() {
    if (!confirm(`Delete ${count} unlinked receipt(s)?`)) return;
    setLoading(true);
    await fetch('/api/costco/receipts/clear', { method: 'POST' });
    setLoading(false);
    router.refresh();
  }

  return (
    <button
      onClick={clear}
      disabled={loading}
      className="text-xs bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
    >
      {loading ? 'Deleting…' : `Clear ${count} unlinked`}
    </button>
  );
}
