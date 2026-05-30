import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';

const COOKIE = 'resell_uid';

export async function getSessionUserId(): Promise<number | null> {
  const jar = await cookies();
  const val = jar.get(COOKIE)?.value;
  if (!val) return null;
  const id = parseInt(val, 10);
  return isNaN(id) ? null : id;
}

export async function getSessionUser() {
  const id = await getSessionUserId();
  if (!id) return null;
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
}
