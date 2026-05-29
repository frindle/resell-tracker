import { prisma } from '@/lib/db';
import { testConnection } from '@/lib/bfmr';

export async function GET() {
  const [keyRow, secretRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bfmr_api_key' } }),
    prisma.setting.findUnique({ where: { key: 'bfmr_api_secret' } }),
  ]);
  if (!keyRow?.value || !secretRow?.value)
    return new Response('No credentials configured', { status: 400 });

  const ok = await testConnection({ apiKey: keyRow.value, apiSecret: secretRow.value });
  return new Response(null, { status: ok ? 200 : 502 });
}
