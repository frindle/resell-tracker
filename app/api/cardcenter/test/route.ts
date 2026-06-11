import { getCcToken } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json() as { email: string; password: string };
  try {
    await getCcToken(email, password);
    return Response.json({ ok: true });
  } catch (e) {
    return new Response(String(e), { status: 400 });
  }
}
