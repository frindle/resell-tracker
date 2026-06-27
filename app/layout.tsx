import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { getSessionUser } from '@/lib/auth';
import NavBar from '@/components/NavBar';
import FirefoxInputGuard from '@/components/FirefoxInputGuard';
import { version } from '@/package.json';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title: 'Reselling',
  description: 'Track reselling profit & loss',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-full bg-gray-950 text-gray-100 antialiased">
        <FirefoxInputGuard />
        <NavBar version={version} userName={user?.name} />
        <main className="mx-auto max-w-6xl px-4 py-6 md:py-8">{children}</main>
      </body>
    </html>
  );
}
