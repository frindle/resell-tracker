'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type UserSummary = { id: number; name: string };

export default function LoginPage() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [loginError, setLoginError] = useState('');

  // First-time setup only
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    fetch('/api/auth/users').then(r => r.json()).then(setUsers);
    fetch('/api/auth/login').then(r => r.json()).then(d => setPasswordRequired(!!d.passwordRequired));
  }, []);

  async function selectUser(userId: number) {
    setLoginError('');
    if (passwordRequired && selectedUserId !== userId) {
      // First click: reveal password field for this user.
      setSelectedUserId(userId);
      return;
    }
    setLoading(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password: passwordRequired ? password : undefined }),
    });
    if (!res.ok) {
      setLoading(false);
      setLoginError(res.status === 401 ? 'Wrong password.' : `Sign-in failed (${res.status})`);
      return;
    }
    window.location.href = '/';
  }

  async function createFirstUser() {
    setAddError('');
    if (!newName.trim()) { setAddError('Name required'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        const user = await res.json();
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: user.id }),
        });
        await fetch('/api/users', { method: 'PUT' });
        window.location.href = '/';
      } else {
        const text = await res.text().catch(() => '');
        let msg: string;
        try { msg = (JSON.parse(text) as { error?: string }).error ?? `Server error ${res.status}`; }
        catch { msg = `Server error ${res.status}: ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`; }
        setAddError(msg);
        setLoading(false);
      }
    } catch (e) {
      setAddError(`Network error: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    }
  }

  const isSetup = users.length === 0;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">
            {isSetup ? 'Welcome to Reselling' : "Who's using this?"}
          </h1>
          {isSetup && (
            <p className="text-gray-400 text-sm mt-1">Create your profile to get started.</p>
          )}
        </div>

        <div className="space-y-2">
          {users.map(u => (
            <div key={u.id} className="space-y-2">
              <button
                onClick={() => selectUser(u.id)}
                disabled={loading}
                className={`w-full text-left px-4 py-3 border rounded-lg text-white font-medium transition-colors disabled:opacity-50 ${
                  selectedUserId === u.id ? 'bg-gray-700 border-blue-600' : 'bg-gray-800 hover:bg-gray-700 border-gray-700'
                }`}
              >
                {u.name}
              </button>
              {passwordRequired && selectedUserId === u.id && (
                <div className="space-y-2 pl-1">
                  <input
                    type="password"
                    value={password}
                    onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                    onKeyDown={e => e.key === 'Enter' && selectUser(u.id)}
                    className="input w-full text-sm"
                    placeholder="Password"
                    autoFocus
                    autoComplete="current-password"
                  />
                  {loginError && <p className="text-xs text-red-400">{loginError}</p>}
                  <button
                    onClick={() => selectUser(u.id)}
                    disabled={loading || !password}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm py-1.5 rounded"
                  >
                    {loading ? 'Signing in…' : 'Sign in'}
                  </button>
                </div>
              )}
            </div>
          ))}

          {isSetup && (
            <div className="space-y-3">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createFirstUser()}
                className="input w-full"
                placeholder="Your name"
                autoFocus
              />
              {addError && <p className="text-red-400 text-sm">{addError}</p>}
              <button
                onClick={createFirstUser}
                disabled={loading || !newName.trim()}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded-md text-sm font-medium transition-colors"
              >
                {loading ? 'Creating…' : 'Create & Continue'}
              </button>
            </div>
          )}

          {!isSetup && (
            <p className="text-xs text-gray-600 pt-1 px-1">
              To add another user, go to{' '}
              <Link href="/settings" className="text-gray-500 hover:text-gray-300 underline">Settings</Link>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
