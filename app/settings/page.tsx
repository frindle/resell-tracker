'use client';

import { useEffect, useState } from 'react';

type ConnectionState = 'idle' | 'testing' | 'ok' | 'fail';

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [conn, setConn] = useState<ConnectionState>('idle');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s.bfmr_api_key) setApiKey(s.bfmr_api_key);
      });
  }, []);

  async function save() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bfmr_api_key: apiKey }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setConn('idle');
  }

  async function testConnection() {
    if (!apiKey) return;
    setConn('testing');
    try {
      const res = await fetch('/api/bfmr/test');
      setConn(res.ok ? 'ok' : 'fail');
    } catch {
      setConn('fail');
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-400 text-sm mt-1">Configure integrations and preferences.</p>
      </div>

      {/* BFMR Integration */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BFMR Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Connect to BuyForMeRetail to sync order tracking and payment status automatically.
          </p>
        </div>

        <div>
          <label className="label">API Key</label>
          <input
            type="password"
            className="input font-mono"
            placeholder="Paste your BFMR API key…"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setConn('idle'); }}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors"
          >
            {saved ? 'Saved!' : 'Save'}
          </button>
          <button
            onClick={testConnection}
            disabled={!apiKey || conn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40"
          >
            {conn === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {conn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {conn === 'fail' && <span className="text-red-400 text-sm">Connection failed — check your API key</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>Sync order tracking numbers and carrier info to order notes</li>
            <li>View pending and issued payments from BFMR on the dashboard</li>
            <li>Match BFMR order IDs to your imported Amazon/Walmart orders</li>
          </ul>
          <p className="text-xs text-gray-600 mt-2">
            API docs: <a href="https://api.bfmr.com/swagger" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">api.bfmr.com/swagger</a>
          </p>
        </div>
      </section>
    </div>
  );
}
