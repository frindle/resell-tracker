import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import crypto from 'node:crypto';

const COOKIE = 'resell_uid';

// Signs the session cookie with SESSION_SECRET (HMAC-SHA256) so a value
// can't be forged by just setting `resell_uid=<any id>` in a browser or
// curl request. If SESSION_SECRET is unset, cookies are unsigned — same
// as the AUTH_PASSWORD pattern elsewhere in this file: LAN-only default,
// opt into hardening by setting the env var.
function sign(id: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return String(id);
  const sig = crypto.createHmac('sha256', secret).update(String(id)).digest('hex');
  return `${id}.${sig}`;
}

export function buildSessionCookie(id: number): string {
  // Secure requires HTTPS; this app's default deployment (docker-compose
  // macvlan, no TLS termination) is plain LAN HTTP, so only add Secure
  // when the operator has explicitly put TLS in front and opts in —
  // otherwise the cookie would silently stop being sent and logins would
  // appear to fail with no error.
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE}=${sign(id)}; HttpOnly; Path=/; SameSite=Lax${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

export async function getSessionUserId(): Promise<number | null> {
  const jar = await cookies();
  const val = jar.get(COOKIE)?.value;
  if (!val) return null;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const id = parseInt(val, 10);
    return isNaN(id) ? null : id;
  }

  const [idPart, sigPart] = val.split('.');
  if (!idPart || !sigPart) return null;
  const id = parseInt(idPart, 10);
  if (isNaN(id)) return null;
  const expected = crypto.createHmac('sha256', secret).update(idPart).digest('hex');
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

export async function getSessionUser() {
  const id = await getSessionUserId();
  if (!id) return null;
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
}
