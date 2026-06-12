import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function POST(_req: NextRequest) {
  const { count } = await prisma.costcoReceipt.deleteMany({ where: { orderId: null } });
  return Response.json({ deleted: count });
}
