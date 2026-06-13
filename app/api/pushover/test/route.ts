import { NextRequest } from 'next/server';
import { sendPushover } from '@/lib/pushover';

export async function POST(req: NextRequest) {
  const { userKey, appToken } = await req.json() as { userKey: string; appToken: string };
  if (!userKey || !appToken) return new Response('Missing credentials', { status: 400 });

  try {
    await sendPushover(userKey, appToken, 'Pushover is connected to Resell Tracker.', 'Test Notification');
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
