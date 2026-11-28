'use client';

import { useRouter } from 'next/navigation';
import DarkbloomPurchase, { type DarkbloomFields } from './DarkbloomPurchase';

/** The Darkbloom purchase action as a bar on the order detail page. */
export default function DarkbloomPurchaseBar({ order }: { order: DarkbloomFields }) {
  const router = useRouter();
  return (
    <div className="border border-gray-800 rounded-lg px-4 py-3 space-y-1">
      <p className="text-xs text-gray-500">Darkbloom purchase: a cost of the Darkbloom business. It stays out of resell P&amp;L and goes to bloom-ledger.</p>
      <DarkbloomPurchase order={order} onDone={() => router.refresh()} />
    </div>
  );
}
