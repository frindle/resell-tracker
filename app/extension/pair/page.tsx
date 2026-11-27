import { getSessionUser } from '@/lib/auth';
import { pairStore, pendingPairing } from '@/lib/extensionPairing';
import ApproveButton from './ApproveButton';

// Where the extension's Pair button lands. proxy.ts sends signed-out visitors to /login and back here.
export const dynamic = 'force-dynamic';

const BROWSER = { chrome: 'Chrome / Brave', firefox: 'Firefox' } as Record<string, string>;

export default async function PairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).code;
  const code = typeof raw === 'string' ? raw : '';
  const pending = code ? pendingPairing(pairStore(), code) : null;
  const user = await getSessionUser();
  const started = pending ? new Date(pending.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '';

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-3 bg-gray-900 border border-gray-800 rounded-lg p-5">
        <h1 className="text-xl font-bold text-white">Pair the extension</h1>
        {!pending ? (
          <p className="text-gray-400 text-sm">This pairing expired or was already used. Press Connect in the extension&apos;s settings again.</p>
        ) : pending.approved ? (
          <p className="text-gray-400 text-sm">Already approved. The extension finishes on its own; you can close this tab.</p>
        ) : (
          <>
            <p className="text-gray-400 text-sm">
              The Reselling Tracker Sync extension in {BROWSER[pending.browser] ?? pending.browser} asked to connect at {started}.
              Approving gives it access as <span className="text-white">{user?.name}</span>.
            </p>
            <p className="text-xs text-gray-500">Only approve if you just pressed Connect in the extension.</p>
            <ApproveButton code={code} />
          </>
        )}
      </div>
    </div>
  );
}
