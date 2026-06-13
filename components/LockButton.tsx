'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LockButton({ orderId, locked }: { orderId: number; locked: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      await fetch(`/api/orders/${orderId}/lock`, { method: locked ? 'DELETE' : 'POST' });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`text-sm px-3 py-1.5 rounded-md transition-colors border whitespace-nowrap disabled:opacity-50 ${
        locked
          ? 'bg-amber-900/40 border-amber-700 text-amber-300 hover:bg-amber-900/60'
          : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
      }`}
    >
      {locked ? 'Unlock Order' : 'Lock Order'}
    </button>
  );
}
