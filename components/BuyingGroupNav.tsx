'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/buyinggroup', label: 'Receipts' },
  { href: '/buyinggroup/deals', label: 'Deals' },
  { href: '/buyinggroup/commitments', label: 'Commitments' },
];

export default function BuyingGroupNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-gray-800">
      {TABS.map(t => {
        const active = t.href === '/buyinggroup' ? pathname === '/buyinggroup' : pathname.startsWith(t.href);
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
