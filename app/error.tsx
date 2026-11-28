'use client';

import ClientErrorPanel from '@/components/ClientErrorPanel';

// Any page that fails to render: show the error and log it on the server, instead of Next's bare "This page couldn't load".
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ClientErrorPanel error={error} reset={reset} />;
}
