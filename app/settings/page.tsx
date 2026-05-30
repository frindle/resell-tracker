'use client';

import { useEffect, useState } from 'react';

type ConnState = 'idle' | 'testing' | 'ok' | 'fail';
type User = { id: number; name: string; _count: { orders: number } };

export default function SettingsPage() {
  // BFMR
  const [bfmrKey, setBfmrKey] = useState('');
  const [bfmrSecret, setBfmrSecret] = useState('');
  const [bfmrConn, setBfmrConn] = useState<ConnState>('idle');
  const [bfmrSaved, setBfmrSaved] = useState(false);

  // Gmail
  const [gmailAddress, setGmailAddress] = useState('');
  const [gmailPassword, setGmailPassword] = useState('');
  const [gmailSaved, setGmailSaved] = useState(false);
  const [gmailConn, setGmailConn] = useState<ConnState>('idle');

  // BuyingGroup
  const [bgEmail, setBgEmail] = useState('');
  const [bgPassword, setBgPassword] = useState('');
  const [bgSaved, setBgSaved] = useState(false);
  const [bgConn, setBgConn] = useState<ConnState>('idle');

  // Users
  const [users, setUsers] = useState<User[]>([]);
  const [newUserName, setNewUserName] = useState('');
  const [userError, setUserError] = useState('');

  // Danger zone
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  function loadUsers() {
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }

  useEffect(() => {
    loadUsers();
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s.bfmr_api_key) setBfmrKey(s.bfmr_api_key);
        if (s.bfmr_api_secret) setBfmrSecret(s.bfmr_api_secret);
        if (s.gmail_address) setGmailAddress(s.gmail_address);
        if (s.gmail_app_password) setGmailPassword(s.gmail_app_password);
        if (s.bg_email) setBgEmail(s.bg_email);
        if (s.bg_password) setBgPassword(s.bg_password);
      });
  }, []);

  async function saveBfmr() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bfmr_api_key: bfmrKey, bfmr_api_secret: bfmrSecret }),
    });
    setBfmrSaved(true);
    setTimeout(() => setBfmrSaved(false), 2000);
    setBfmrConn('idle');
  }

  async function testBfmr() {
    if (!bfmrKey || !bfmrSecret) return;
    setBfmrConn('testing');
    try {
      const res = await fetch('/api/bfmr/test');
      setBfmrConn(res.ok ? 'ok' : 'fail');
    } catch {
      setBfmrConn('fail');
    }
  }

  async function saveGmail() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gmail_address: gmailAddress, gmail_app_password: gmailPassword }),
    });
    setGmailSaved(true);
    setTimeout(() => setGmailSaved(false), 2000);
    setGmailConn('idle');
  }

  async function testGmail() {
    if (!gmailAddress || !gmailPassword) return;
    setGmailConn('testing');
    try {
      const res = await fetch('/api/email/sync');
      setGmailConn(res.ok ? 'ok' : 'fail');
    } catch {
      setGmailConn('fail');
    }
  }

  async function saveBg() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bg_email: bgEmail, bg_password: bgPassword }),
    });
    setBgSaved(true);
    setTimeout(() => setBgSaved(false), 2000);
    setBgConn('idle');
  }

  async function testBg() {
    if (!bgEmail || !bgPassword) return;
    setBgConn('testing');
    try {
      const res = await fetch('/api/buyinggroup/login');
      setBgConn(res.ok ? 'ok' : 'fail');
    } catch {
      setBgConn('fail');
    }
  }

  async function addUser() {
    setUserError('');
    if (!newUserName.trim()) return;
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName.trim() }),
    });
    if (res.ok) {
      setNewUserName('');
      loadUsers();
    } else {
      const d = await res.json();
      setUserError(d.error ?? 'Failed');
    }
  }

  async function deleteAllOrders() {
    setDeleting(true);
    await fetch('/api/orders', { method: 'DELETE' });
    setDeleting(false);
    setDeleteConfirm(false);
    loadUsers();
  }

  async function removeUser(id: number) {
    if (!confirm('Delete this user? Their orders will be unassigned.')) return;
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    loadUsers();
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-400 text-sm mt-1">Configure integrations and preferences.</p>
      </div>

      {/* BFMR */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BFMR Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Connect to BuyForMeRetail to view your tracker, active deals, and shipment insurance.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">API Key</label>
            <input type="password" className="input font-mono" placeholder="API-KEY"
              value={bfmrKey} onChange={e => { setBfmrKey(e.target.value); setBfmrConn('idle'); }} />
          </div>
          <div>
            <label className="label">API Secret</label>
            <input type="password" className="input font-mono" placeholder="API-SECRET"
              value={bfmrSecret} onChange={e => { setBfmrSecret(e.target.value); setBfmrConn('idle'); }} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={saveBfmr} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {bfmrSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testBfmr} disabled={!bfmrKey || !bfmrSecret || bfmrConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {bfmrConn === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {bfmrConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {bfmrConn === 'fail' && <span className="text-red-400 text-sm">Failed — check your API key and secret</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>View My Tracker — order numbers, tracking, payment status and amounts</li>
            <li>Browse active deals available to reserve</li>
            <li>File and manage shipment insurance</li>
          </ul>
        </div>
      </section>

      {/* Gmail */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Gmail Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Import order confirmation emails and auto-delete them after processing.
            Requires a Gmail App Password — not your regular password.
          </p>
        </div>

        <div>
          <label className="label">Gmail Address</label>
          <input type="email" className="input" placeholder="you@gmail.com"
            value={gmailAddress} onChange={e => { setGmailAddress(e.target.value); setGmailConn('idle'); }} />
        </div>
        <div>
          <label className="label">App Password</label>
          <input type="password" className="input font-mono" placeholder="xxxx xxxx xxxx xxxx"
            value={gmailPassword} onChange={e => { setGmailPassword(e.target.value); setGmailConn('idle'); }} />
          <p className="text-xs text-gray-500 mt-1">
            Generate at{' '}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
              myaccount.google.com/apppasswords
            </a>
            {' '}— requires 2FA to be enabled on your Google account.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={saveGmail} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {gmailSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testGmail} disabled={!gmailAddress || !gmailPassword || gmailConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {gmailConn === 'testing' ? 'Connecting…' : 'Test Connection'}
          </button>
          {gmailConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {gmailConn === 'fail' && <span className="text-red-400 text-sm">Failed — check address and app password</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>Scan inbox for Amazon, Walmart, and BuyingGroup order emails</li>
            <li>Pre-fill order number, cost, and shipping address from email</li>
            <li>Delete emails from Gmail immediately after importing</li>
          </ul>
        </div>
      </section>

      {/* BuyingGroup */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BuyingGroup Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Connect to BuyingGroup.com to view your receipts and browse active deals.
            Uses your BuyingGroup.com login credentials.
          </p>
        </div>

        <div>
          <label className="label">Email</label>
          <input type="email" className="input" placeholder="you@example.com"
            value={bgEmail} onChange={e => { setBgEmail(e.target.value); setBgConn('idle'); }} />
        </div>
        <div>
          <label className="label">Password</label>
          <input type="password" className="input" placeholder="Your BuyingGroup.com password"
            value={bgPassword} onChange={e => { setBgPassword(e.target.value); setBgConn('idle'); }} />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={saveBg} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {bgSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testBg} disabled={!bgEmail || !bgPassword || bgConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {bgConn === 'testing' ? 'Connecting…' : 'Test Connection'}
          </button>
          {bgConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {bgConn === 'fail' && <span className="text-red-400 text-sm">Failed — check email and password</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>View receipts — order numbers, tracking, payout amounts and dates</li>
            <li>Browse active deals with cashback spread calculator</li>
          </ul>
        </div>
      </section>

      {/* Users */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-gray-400 text-sm mt-1">
            Each user has their own orders, settings, and API credentials. Buyers are shared.
          </p>
        </div>

        {users.length > 0 && (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-right">Orders</th>
                  <th className="px-4 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2 text-gray-200">{u.name}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{u._count.orders}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => removeUser(u.id)}
                        className="text-gray-600 hover:text-red-400 transition-colors text-xs"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label">Add user</label>
            <input
              type="text"
              value={newUserName}
              onChange={e => setNewUserName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addUser()}
              className="input w-full"
              placeholder="Name"
            />
          </div>
          <button
            onClick={addUser}
            disabled={!newUserName.trim()}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors"
          >
            Add
          </button>
        </div>
        {userError && <p className="text-red-400 text-sm">{userError}</p>}
      </section>

      {/* Danger zone */}
      <section className="rounded-lg border border-red-900/50 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          <p className="text-gray-400 text-sm mt-1">These actions are permanent and cannot be undone.</p>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-200">Delete all orders</p>
            <p className="text-xs text-gray-500 mt-0.5">Permanently removes all your orders from the database.</p>
          </div>
          {!deleteConfirm ? (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="bg-gray-800 hover:bg-red-900/60 border border-red-900/50 text-red-400 text-sm px-4 py-2 rounded-md transition-colors"
            >
              Delete All Orders
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-400">Are you sure?</span>
              <button
                onClick={deleteAllOrders}
                disabled={deleting}
                className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-md transition-colors"
              >
                {deleting ? 'Deleting…' : 'Yes, delete all'}
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="text-gray-400 hover:text-white text-sm px-3 py-2 rounded-md transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
