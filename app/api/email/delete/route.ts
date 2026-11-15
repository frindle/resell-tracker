import { getSessionUserId } from '@/lib/auth';
import { deleteEmails } from '@/lib/emailSync';
import { orderInboxCreds } from '@/lib/emailCreds';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const inbox = await orderInboxCreds(userId ?? null);
  if (!inbox) return new Response('Order email inbox not configured', { status: 400 });

  const { uids } = await req.json() as { uids: number[] };
  if (!uids?.length) return new Response('No UIDs provided', { status: 400 });
  if (!uids.every(u => Number.isInteger(u) && u > 0)) return new Response('Bad UIDs', { status: 400 });

  try {
    await deleteEmails(inbox.creds, uids);
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
