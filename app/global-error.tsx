'use client';

import './globals.css';
import ClientErrorPanel from '@/components/ClientErrorPanel';

// The root layout itself failed: this replaces the whole document, so it brings its own html and body.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-gray-950 p-6 text-gray-100 antialiased">
        <ClientErrorPanel error={error} reset={reset} />
      </body>
    </html>
  );
}
