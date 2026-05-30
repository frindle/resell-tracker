'use client';

import { useRouter } from 'next/navigation';

export default function UserMenu({ name }: { name: string }) {
  const router = useRouter();

  async function handleSwitch() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-400">{name}</span>
      <button
        onClick={handleSwitch}
        className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
      >
        Switch
      </button>
    </div>
  );
}
