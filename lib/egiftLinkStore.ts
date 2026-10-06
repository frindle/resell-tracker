import { prisma } from './db';

export async function upsertOrderEgiftLink(
  orderId: number,
  linkEnc: string,
  linkHash: string,
): Promise<{ id: number; orderId: number; linkEnc: string; linkHash: string; createdAt: Date; updatedAt: Date }> {
  const row = await prisma.orderEgiftLink.upsert({
    where: { orderId },
    create: { orderId, linkEnc, linkHash },
    update: { linkEnc, linkHash },
  });
  return row;
}
