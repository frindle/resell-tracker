'use client';

import { useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';

type NavLink = { href: string; label: string };
type NavGroup = { label: string; items: NavLink[] };
type NavItem = NavLink | NavGroup;

// Buyer portals share one "Buyers" menu so the bar fits on one line.
// Import lives under /settings; Address Rules moved there too.
// "Activity" covers /sync-history and /api-errors (the Sync page owns the deep-link).
const BUYERS: NavGroup = {
  label: 'Buyers',
  items: [
    { href: '/buyers', label: 'All buyers' },
    { href: '/bfmr', label: 'BFMR' },
    { href: '/buyinggroup', label: 'BuyingGroup' },
    { href: '/cardcenter', label: 'CardCenter' },
  ],
};

function navItems(booksOn: boolean): NavItem[] {
  return [
    { href: '/analytics', label: 'Analytics' },
    { href: '/orders', label: 'Orders' },
    BUYERS,
    { href: '/cards', label: 'Cards' },
    { href: '/loans', label: 'Loans' },
    ...(booksOn ? [{ href: '/books', label: 'Books' }] : []),
    { href: '/sync-history', label: 'Activity' },
  ];
}

const isGroup = (i: NavItem): i is NavGroup => 'items' in i;

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  if (href === '/orders') return pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new');
  return pathname === href || pathname.startsWith(href + '/');
}

// Closes on outside click, Escape, and when one of its links is clicked.
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const LINK = 'whitespace-nowrap px-2.5 py-1.5 rounded-md transition-colors inline-flex items-center gap-1.5';
const IDLE = 'text-gray-400 hover:text-white hover:bg-gray-800/60';
const ON = 'text-white bg-gray-800';

function Chevron() {
  return (
    <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function GroupMenu({ group, pathname }: { group: NavGroup; pathname: string | null }) {
  const { open, setOpen, ref } = useDropdown();
  const active = group.items.some(i => isActive(pathname, i.href));
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${LINK} ${active ? ON : IDLE}`}
      >
        {group.label}
        <Chevron />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 min-w-[11rem] rounded-md border border-gray-800 bg-gray-900 py-1 shadow-xl z-50">
          {group.items.map(i => (
            <Link
              key={i.href}
              href={i.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={`block whitespace-nowrap px-3 py-2 text-sm transition-colors ${isActive(pathname, i.href) ? 'text-white bg-gray-800' : 'text-gray-300 hover:text-white hover:bg-gray-800/60'}`}
            >
              {i.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu({ name, pathname }: { name: string; pathname: string | null }) {
  const { open, setOpen, ref } = useDropdown();
  const router = useRouter();
  async function handleSwitch() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }
  const settingsOn = isActive(pathname, '/settings');
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${LINK} ${settingsOn ? ON : IDLE}`}
      >
        <span className="w-6 h-6 rounded-full bg-gray-700 text-gray-200 text-xs font-semibold inline-flex items-center justify-center" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="max-w-[8rem] truncate">{name}</span>
        <Chevron />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 min-w-[10rem] rounded-md border border-gray-800 bg-gray-900 py-1 shadow-xl z-50">
          <Link href="/settings" role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800/60">
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleSwitch}
            className="block w-full text-left px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800/60"
          >
            Switch user
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({ count }: { count: number }) {
  return (
    <span
      className="bg-red-600 text-white text-[11px] leading-none font-semibold rounded-full px-1.5 py-1 min-w-[1.25rem] text-center"
      title={`${count} unread error${count === 1 ? '' : 's'}`}
    >
      {count}
    </span>
  );
}

export default function NavBar({ version, userName }: { version: string; userName?: string }) {
  const [open, setOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [unreadErrors, setUnreadErrors] = useState(0);
  // "Books" only shows once Setting accounting.enabled is on.
  const [booksOn, setBooksOn] = useState(false);
  const router = useRouter();

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

  useEffect(() => {
    fetch('/api/books/status').then(r => (r.ok ? r.json() : null)).then(d => setBooksOn(!!d?.enabled)).catch(() => {});
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

  const items = navItems(booksOn);

  async function handleSwitch() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <nav className="border-b border-gray-800 bg-gray-900">
      <div className="mx-auto max-w-7xl px-4 flex items-center h-14 gap-4">
        <div className="flex items-baseline gap-2 shrink-0">
          <Link href="/" className="font-semibold text-white text-lg tracking-tight">
            Reselling
          </Link>
          <span className="text-gray-600 text-xs">v{version}</span>
          {updateAvailable && (
            <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/60 text-yellow-300" title={`v${updateAvailable} available`}>
              update
            </span>
          )}
        </div>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-0.5 text-sm">
          {items.map(item => isGroup(item) ? (
            <GroupMenu key={item.label} group={item} pathname={pathname} />
          ) : (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              className={`${LINK} ${isActive(pathname, item.href) ? ON : IDLE}`}
            >
              {item.label}
              {item.href === '/sync-history' && unreadErrors > 0 && <Badge count={unreadErrors} />}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 text-sm">
          <Link
            href="/orders/new"
            className="hidden lg:inline-flex whitespace-nowrap bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-md transition-colors"
          >
            + New Order
          </Link>
          {userName ? (
            <div className="hidden lg:block">
              <AccountMenu name={userName} pathname={pathname} />
            </div>
          ) : (
            <Link
              href="/settings"
              className={`hidden lg:inline-flex ${LINK} ${isActive(pathname, '/settings') ? ON : IDLE}`}
            >
              Settings
            </Link>
          )}
          {/* Hamburger */}
          <button
            className="lg:hidden p-2 text-gray-400 hover:text-white transition-colors inline-flex items-center gap-1.5"
            onClick={() => setOpen(o => !o)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {!open && unreadErrors > 0 && <Badge count={unreadErrors} />}
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
        <div className="lg:hidden border-t border-gray-800 bg-gray-900 px-4 py-3">
          <div className="space-y-0.5">
            {items.map(item => isGroup(item) ? (
              <div key={item.label} className="pt-2">
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-600">{item.label}</div>
                {item.items.map(i => (
                  <Link
                    key={i.href}
                    href={i.href}
                    onClick={() => setOpen(false)}
                    className={`block rounded-md px-2 py-2 pl-4 text-sm transition-colors ${isActive(pathname, i.href) ? 'text-white bg-gray-800' : 'text-gray-300 hover:text-white'}`}
                  >
                    {i.label}
                  </Link>
                ))}
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors ${isActive(pathname, item.href) ? 'text-white bg-gray-800' : 'text-gray-300 hover:text-white'}`}
              >
                {item.label}
                {item.href === '/sync-history' && unreadErrors > 0 && <Badge count={unreadErrors} />}
              </Link>
            ))}
          </div>
          <div className="pt-3 border-t border-gray-800 mt-3 flex flex-col gap-2">
            <Link
              href="/orders/new"
              onClick={() => setOpen(false)}
              className="block w-full text-center bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded-md transition-colors"
            >
              + New Order
            </Link>
            <div className="flex items-center justify-between px-2 text-sm">
              <Link href="/settings" onClick={() => setOpen(false)} className="text-gray-300 hover:text-white">Settings</Link>
              {userName && (
                <span className="flex items-center gap-3">
                  <span className="text-gray-500">{userName}</span>
                  <button type="button" onClick={handleSwitch} className="text-gray-300 hover:text-white">Switch user</button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
