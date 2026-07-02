import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';

// If AUTH_PASSWORD is set in env, require the client to POST it in the
// body. Constant-time compare + 400ms sleep on mismatch to slow brute force
// (there's a single global password, so cost is one attempt / 400ms). No
// per-user password — this route is the outer gate on the app itself.
// If AUTH_PASSWORD is unset, behavior is unchanged (LAN-only default).
async function verifyGlobalPassword(provided: unknown): Promise<boolean> {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return true;
  if (typeof provided !== 'string' || provided.length === 0) {
    await new Promise(r => setTimeout(r, 400));
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    await new Promise(r => setTimeout(r, 400));
    return false;
  }
  const ok = timingSafeEqual(a, b);
  if (!ok) await new Promise(r => setTimeout(r, 400));
  return ok;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, password } = body ?? {};
    if (!userId) return Response.json({ error: 'Missing userId' }, { status: 400 });

    if (!(await verifyGlobalPassword(password))) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
    if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

    const res = Response.json({ id: user.id, name: user.name });
    res.headers.set('Set-Cookie', `resell_uid=${user.id}; HttpOnly; Path=/; SameSite=Lax`);
    return res;
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// So the login page can decide whether to show the password field. Doesn't
// leak the password — only whether one is required.
export async function GET() {
  return Response.json({ passwordRequired: !!process.env.AUTH_PASSWORD });
}
