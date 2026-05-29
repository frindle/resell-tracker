import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import Link from 'next/link';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title: 'Resell Tracker',
  description: 'Track reselling profit & loss',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-full bg-gray-950 text-gray-100 antialiased">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="mx-auto max-w-6xl px-4 flex items-center gap-6 h-14">
            <Link href="/" className="font-semibold text-white text-lg tracking-tight">
              Resell Tracker
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/orders" className="text-gray-400 hover:text-white transition-colors">
                Orders
              </Link>
              <Link href="/buyers" className="text-gray-400 hover:text-white transition-colors">
                Buyers
              </Link>
              <Link href="/cards" className="text-gray-400 hover:text-white transition-colors">
                Cards
              </Link>
              <Link href="/import" className="text-gray-400 hover:text-white transition-colors">
                Import
              </Link>
              <Link href="/settings" className="text-gray-400 hover:text-white transition-colors">
                Settings
              </Link>
            </div>
            <div className="ml-auto">
              <Link
                href="/orders/new"
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-md transition-colors"
              >
                + New Order
              </Link>
            </div>
          </div>
        </nav>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
