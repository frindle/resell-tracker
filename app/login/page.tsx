'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type UserSummary = { id: number; name: string };

export default function LoginPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // Add user form
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    fetch('/api/auth/users').then(r => r.json()).then(setUsers);
  }, []);

  async function selectUser(userId: number) {
    setLoading(true);
    await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    router.push('/');
    router.refresh();
  }

  async function createUser() {
    setAddError('');
    if (!newName.trim()) { setAddError('Name required'); return; }
    setLoading(true);
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      const user = await res.json();
      // If first user, claim any existing unclaimed data
      if (users.length === 0) await fetch('/api/users', { method: 'PUT' });
      await selectUser(user.id);
    } else {
      const data = await res.json();
      setAddError(data.error ?? 'Failed to create user');
      setLoading(false);
    }
  }

  const isSetup = users.length === 0 && !loading;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">
            {isSetup ? 'Welcome to Reselling' : "Who's using this?"}
          </h1>
          {isSetup && (
            <p className="text-gray-400 text-sm mt-1">Create your first profile to get started.</p>
          )}
        </div>

        <div className="space-y-2">
          {users.map(u => (
            <button
              key={u.id}
              onClick={() => selectUser(u.id)}
              disabled={loading}
              className="w-full text-left px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-white font-medium transition-colors disabled:opacity-50"
            >
              {u.name}
            </button>
          ))}

          {adding || isSetup ? (
            <div className={`space-y-3 ${!isSetup ? 'pt-2 border-t border-gray-800' : ''}`}>
              {!isSetup && <p className="text-sm font-medium text-gray-300">Add a user</p>}
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createUser()}
                className="input w-full"
                placeholder="Your name"
                autoFocus
              />
              {addError && <p className="text-red-400 text-sm">{addError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={createUser}
                  disabled={loading}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded-md text-sm font-medium transition-colors"
                >
                  {loading ? 'Creating…' : isSetup ? 'Create & Continue' : 'Add User'}
                </button>
                {!isSetup && (
                  <button
                    onClick={() => { setAdding(false); setNewName(''); setAddError(''); }}
                    className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-md text-sm transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="w-full text-sm text-gray-500 hover:text-gray-300 py-2 transition-colors text-left px-4"
            >
              + Add a user
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
