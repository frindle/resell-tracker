'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import UserMenu from '@/components/UserMenu';

const NAV_LINKS = [
  { href: '/analytics', label: 'Analytics' },
  { href: '/orders', label: 'Orders' },
  { href: '/buyers', label: 'Buyers' },
  { href: '/cards', label: 'Credit Cards' },
  // Merged: /sync-history and /api-errors both surface via this single
  // "Activity" tab. The Sync page owns the deep-link.
  { href: '/sync-history', label: 'Activity' },
  { href: '/bfmr', label: 'BFMR' },
  { href: '/buyinggroup', label: 'BuyingGroup' },
  { href: '/cardcenter', label: 'CardCenter' },
  // Import removed from top nav (was low-frequency); reach it from /settings
  // if it needs to come back. Address Rules moved under /settings.
  { href: '/settings', label: 'Settings' },
];

export default function NavBar({ version, userName }: { version: string; userName?: string }) {
  const [open, setOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [unreadErrors, setUnreadErrors] = useState(0);

  // Re-check on every page navigation, not just on mount: the NavBar lives
  // in the root layout and survives client-side navigation, so a long-lived
  // tab would otherwise never notice new commits and the "update" tag
  // stops firing. (/api/version caches the GitHub call for 5 min.)
  const pathname = usePathname();
  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(d => {
      setUpdateAvailable(d.outdated && d.latest ? d.latest : null);
    }).catch(() => {});
  }, [pathname]);

  // Poll the unread API-error count every 60s so a recent failure
  // surfaces as a badge in the nav. Cheap query (indexed count).
  useEffect(() => {
    const fetchCount = () => fetch('/api/api-errors/unread-count').then(r => r.json()).then((d: { count?: number }) => {
      setUnreadErrors(d.count ?? 0);
    }).catch(() => {});
    fetchCount();
    const id = setInterval(fetchCount, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <nav className="border-b border-gray-800 bg-gray-900">
      <div className="mx-auto max-w-6xl px-4 flex items-center h-14">
        <Link href="/" className="font-semibold text-white text-lg tracking-tight shrink-0">
          Reselling
        </Link>
        <span className="text-gray-600 text-xs ml-2 shrink-0">v{version}</span>
        {updateAvailable && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/60 text-yellow-300 shrink-0" title={`v${updateAvailable} available`}>
            update
          </span>
        )}

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-4 text-sm ml-6">
          {NAV_LINKS.map(l => (
            <Link key={l.href} href={l.href} className="text-gray-400 hover:text-white transition-colors inline-flex items-center gap-1.5">
              {l.label}
              {l.href === '/sync-history' && unreadErrors > 0 && (
                <span className="bg-red-600 text-white text-xs font-semibold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center" title={`${unreadErrors} unread error${unreadErrors === 1 ? '' : 's'}`}>{unreadErrors}</span>
              )}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {userName && (
            <div className="hidden md:block">
              <UserMenu name={userName} />
            </div>
          )}
          <Link
            href="/orders/new"
            className="hidden md:inline-flex bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
          >
            + New Order
          </Link>
          {/* Hamburger */}
          <button
            className="md:hidden p-2 text-gray-400 hover:text-white transition-colors"
            onClick={() => setOpen(o => !o)}
            aria-label="Toggle menu"
          >
            {open ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-gray-800 bg-gray-900 px-4 py-3 space-y-1">
          {NAV_LINKS.map(l => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block py-2 text-gray-300 hover:text-white text-sm transition-colors"
            >
              {l.label}
            </Link>
          ))}
          <div className="pt-2 border-t border-gray-800 mt-2 flex flex-col gap-2">
            <Link
              href="/orders/new"
              onClick={() => setOpen(false)}
              className="block w-full text-center bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded-md transition-colors"
            >
              + New Order
            </Link>
            {userName && <UserMenu name={userName} />}
          </div>
        </div>
      )}
    </nav>
  );
}
