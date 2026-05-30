import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { deleteEmails } from '@/lib/emailSync';
import { NextRequest } from 'next/server';

async function getCreds(uid: number | null) {
  const [addr, pass] = await Promise.all([
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'gmail_address' } } }),
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'gmail_app_password' } } }),
  ]);
  if (!addr?.value || !pass?.value) return null;
  return { address: addr.value, appPassword: pass.value };
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const creds = await getCreds(userId ?? null);
  if (!creds) return new Response('Gmail not configured', { status: 400 });

  const { uids } = await req.json() as { uids: number[] };
  if (!uids?.length) return new Response('No UIDs provided', { status: 400 });

  try {
    await deleteEmails(creds, uids);
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
