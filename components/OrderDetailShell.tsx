'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import OrderForm, { type OrderFormHandle } from '@/components/OrderForm';
import LockButton from '@/components/LockButton';

type OrderShellProps = {
  returnTo?: string;
  initialData: React.ComponentProps<typeof OrderForm>['initialData'];
  orderId: number;
  locked: boolean;
  cancelled: boolean;
  platform: string;
  merchantUrl: string | null;
  titleDescription: string;
};

// Wraps the "Edit Order" heading + full action-button row + OrderForm so the
// four action buttons (Save Changes, Save and Lock, Lock/Unlock, View on
// merchant) share the page header line, matching the pre-2026-07-02 layout
// with Save and Lock added. Requires OrderForm to forward its submit
// handler through the OrderFormHandle ref.
export default function OrderDetailShell(props: OrderShellProps) {
  const { returnTo, initialData, orderId, locked, cancelled, platform, merchantUrl, titleDescription } = props;
  const formRef = useRef<OrderFormHandle>(null);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();

  async function fire(opts?: { lockAfterSave?: boolean }) {
    setSaving(true);
    try {
      formRef.current?.submit(opts);
    } finally {
      // OrderForm sets its own internal saving state; we only need the local
      // flag to prevent double-clicks in the ~one-tick window before it takes
      // over. Give React one frame to re-render.
      requestAnimationFrame(() => setSaving(false));
    }
  }

  async function cancelOrder() {
    if (!confirm('Cancel this order? Cost, sale price, cashback, and any commitment links will be zeroed out, and the order will be locked.')) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/cancel`, { method: 'POST' });
      if (res.ok) router.refresh();
      else alert('Failed to cancel order');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Edit Order</h1>
          <p className="text-gray-400 text-sm mt-1">{titleDescription}</p>
        </div>
        <div className="flex flex-row flex-wrap items-center gap-2 shrink-0">
          {!locked && (
            <>
              <button
                type="button"
                onClick={() => fire()}
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md transition-colors border border-blue-700 whitespace-nowrap"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={() => fire({ lockAfterSave: true })}
                disabled={saving}
                className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-sm px-3 py-1.5 rounded-md transition-colors border border-amber-800 whitespace-nowrap"
              >
                {saving ? 'Saving…' : 'Save and Lock'}
              </button>
            </>
          )}
          <LockButton orderId={orderId} locked={locked} />
          {!locked && !cancelled && (
            <button
              type="button"
              onClick={cancelOrder}
              disabled={cancelling}
              className="bg-red-950 hover:bg-red-900 disabled:opacity-50 text-red-300 text-sm px-3 py-1.5 rounded-md transition-colors border border-red-800 whitespace-nowrap"
            >
              {cancelling ? 'Cancelling…' : 'Cancel Order'}
            </button>
          )}
          {cancelled && (
            <span className="bg-gray-800 text-gray-400 text-sm px-3 py-1.5 rounded-md border border-gray-700 whitespace-nowrap">Cancelled</span>
          )}
          {merchantUrl && (
            <a
              href={merchantUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded-md transition-colors whitespace-nowrap inline-flex items-center"
            >
              View on {platform} →
            </a>
          )}
        </div>
      </div>
      <OrderForm ref={formRef} initialData={initialData} returnTo={returnTo} />
    </>
  );
}
