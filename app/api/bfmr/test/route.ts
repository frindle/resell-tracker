import { prisma } from '@/lib/db';
import { testConnection } from '@/lib/bfmr';

export async function GET() {
  const setting = await prisma.setting.findUnique({ where: { key: 'bfmr_api_key' } });
  if (!setting?.value) return new Response('No API key configured', { status: 400 });

  const ok = await testConnection(setting.value);
  return new Response(null, { status: ok ? 200 : 502 });
}
