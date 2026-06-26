import { PrismaClient } from '@/app/generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { SENSITIVE_SETTING_KEYS, encryptSetting, decryptSetting } from './secrets';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createClient() {
  const dbUrl = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
  const url = dbUrl.replace(/^file:/, '');
  console.log('[db] connecting to', url);
  try {
    const adapter = new PrismaBetterSqlite3({ url });
    const client = new PrismaClient({ adapter } as never);
    console.log('[db] client created OK');
    return client;
  } catch (e) {
    console.error('[db] createClient failed:', e);
    throw e;
  }
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Helpers for Settings with nullable userId (Prisma compound unique rejects null in where).
//
// Transparently encrypt+decrypt values for keys in SENSITIVE_SETTING_KEYS so
// passwords aren't readable from the SQLite file. See lib/secrets.ts for the
// on-disk format. When EXTENSION_DATA_KEY is unset the helpers act as
// passthroughs — legacy plaintext stays readable until the key is configured.
export async function getSetting(userId: number | null, key: string) {
  const row = await prisma.setting.findFirst({ where: { userId, key } });
  if (row && SENSITIVE_SETTING_KEYS.has(key)) {
    return { ...row, value: decryptSetting(row.value) };
  }
  return row;
}

export async function upsertSetting(userId: number | null, key: string, value: string) {
  const stored = SENSITIVE_SETTING_KEYS.has(key) ? encryptSetting(value) : value;
  const existing = await prisma.setting.findFirst({ where: { userId, key } });
  if (existing) {
    await prisma.setting.update({ where: { id: existing.id }, data: { value: stored } });
  } else {
    await prisma.setting.create({ data: { userId, key, value: stored } });
  }
}
