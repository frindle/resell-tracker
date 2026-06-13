'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/bfmr', label: 'Tracker' },
  { href: '/bfmr/deals', label: 'Deals' },
  { href: '/bfmr/watcher', label: 'Watcher' },
];

export default function BfmrNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-gray-800">
      {TABS.map(t => {
        const active = t.href === '/bfmr' ? pathname === '/bfmr' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
              active
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
