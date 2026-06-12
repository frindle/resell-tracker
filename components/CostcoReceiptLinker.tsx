'use client';

import { useEffect, useState } from 'react';

type Receipt = {
  id: number;
  transactionBarcode: string;
  transactionDate: string;
  warehouseName: string;
  total: number;
};

export default function CostcoReceiptLinker({ orderId, orderDate }: { orderId: number; orderDate: string }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/costco/receipts')
      .then(r => r.json())
      .then((all: (Receipt & { candidates: { id: number }[] })[]) => {
        // Show receipts from the same date as this order
        const orderDay = orderDate.split('T')[0];
        setReceipts(all.filter(r => r.transactionDate === orderDay));
      })
      .catch(() => {});
  }, [orderDate]);

  if (receipts.length === 0) return null;

  async function link(barcode: string) {
    setLinking(barcode);
    const res = await fetch(`/api/costco/receipts/${barcode}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    if (res.ok) {
      setReceipts(prev => prev.filter(r => r.transactionBarcode !== barcode));
      window.location.reload();
    }
    setLinking(null);
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-300">Unlinked Costco Receipts from This Date</h3>
      {receipts.map(r => (
        <div key={r.transactionBarcode} className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded px-3 py-2">
          <div className="text-sm">
            <span className="text-gray-200">{r.warehouseName}</span>
            <span className="text-gray-400 ml-2">${r.total.toFixed(2)}</span>
            <span className="text-gray-600 text-xs ml-2">{r.transactionBarcode}</span>
          </div>
          <button
            onClick={() => link(r.transactionBarcode)}
            disabled={linking === r.transactionBarcode}
            className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white px-2 py-1 rounded transition-colors"
          >
            {linking === r.transactionBarcode ? 'Linking…' : 'Link Receipt'}
          </button>
        </div>
      ))}
    </div>
  );
}
