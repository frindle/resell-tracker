import { getSessionUserId } from '@/lib/auth';
import { deleteEmails } from '@/lib/emailSync';
import { deleteCloudflareMessages } from '@/lib/emailCloudflare';
import { orderInboxCreds } from '@/lib/emailCreds';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const inbox = await orderInboxCreds(userId ?? null);
  if (!inbox) return new Response('Order email inbox not configured', { status: 400 });

  // Gmail ids are numeric IMAP UIDs, Cloudflare ids are the worker's "m:..." keys.
  const { uids } = await req.json() as { uids: Array<number | string> };
  if (!uids?.length) return new Response('No UIDs provided', { status: 400 });

  try {
    if (inbox.kind === 'cloudflare') {
      if (!uids.every(u => typeof u === 'string' && u.startsWith('m:') && u.length < 200)) return new Response('Bad ids', { status: 400 });
      await deleteCloudflareMessages(inbox.cf, uids as string[]);
    } else {
      if (!uids.every(u => typeof u === 'number' && Number.isInteger(u) && u > 0)) return new Response('Bad UIDs', { status: 400 });
      await deleteEmails(inbox.creds, uids as number[]);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
