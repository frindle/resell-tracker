// Per-user tokens for uploading photos from outside the browser (iOS
// Shortcut). Only a SHA-256 of the token is stored; the token itself is
// shown once when created. A token authorizes POST /api/upload/photo only.
import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/db';

export const hashUploadToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function newUploadToken(): string {
  return `rtu_${randomBytes(24).toString('base64url')}`;
}

/** Returns the user id for a valid, unrevoked token, else null. */
export async function userForUploadToken(authHeader: string | null): Promise<number | null> {
  const m = authHeader?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const row = await prisma.uploadToken.findUnique({ where: { tokenHash: hashUploadToken(m[1]) } });
  if (!row || row.revokedAt) return null;
  await prisma.uploadToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return row.userId;
}
