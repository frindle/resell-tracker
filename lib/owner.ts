import { prisma } from '@/lib/db';

// The tracker's owner: OWNER_USER_ID when set, otherwise the first user
// created. Install-wide settings (like the Cloudflare upload token) can only
// be changed by this user.
export async function getOwnerUserId(): Promise<number | null> {
  const env = parseInt(process.env.OWNER_USER_ID ?? '', 10);
  if (!isNaN(env)) return env;
  const first = await prisma.user.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
  return first?.id ?? null;
}

export async function isOwner(userId: number | null): Promise<boolean> {
  if (userId == null) return false;
  return (await getOwnerUserId()) === userId;
}
