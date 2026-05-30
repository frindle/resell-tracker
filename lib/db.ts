import { PrismaClient } from '@/app/generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createClient() {
  const dbUrl = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
  const url = dbUrl.replace(/^file:/, '');
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter } as never);
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Helpers for Settings with nullable userId (Prisma compound unique rejects null in where)
export async function getSetting(userId: number | null, key: string) {
  return prisma.setting.findFirst({ where: { userId, key } });
}

export async function upsertSetting(userId: number | null, key: string, value: string) {
  const existing = await prisma.setting.findFirst({ where: { userId, key } });
  if (existing) {
    await prisma.setting.update({ where: { id: existing.id }, data: { value } });
  } else {
    await prisma.setting.create({ data: { userId, key, value } });
  }
}
