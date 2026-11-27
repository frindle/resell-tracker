'use client';

import { useState } from 'react';

export default function ApproveButton({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle');
  const [msg, setMsg] = useState('');

  async function approve() {
    setState('busy');
    const res = await fetch('/api/extension/pair/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (res?.ok) {
      setState('done');
      setMsg('Approved. The extension connects within a few seconds; you can close this tab.');
    } else {
      setState('fail');
      setMsg(body?.error ?? `Approval failed (${res?.status ?? 'network error'})`);
    }
  }

  if (state === 'done') return <p className="text-green-400 text-sm">{msg}</p>;
  return (
    <div className="space-y-2">
      <button
        onClick={approve}
        disabled={state === 'busy'}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded-md text-sm font-medium transition-colors"
      >
        {state === 'busy' ? 'Approving…' : 'Approve'}
      </button>
      {state === 'fail' && <p className="text-red-400 text-sm">{msg}</p>}
    </div>
  );
}
