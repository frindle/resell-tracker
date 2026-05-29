import { prisma } from '@/lib/db';
import { login, refreshToken } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

async function getCreds() {
  const [email, pass] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_email' } }),
    prisma.setting.findUnique({ where: { key: 'bg_password' } }),
  ]);
  if (!email?.value || !pass?.value) return null;
  return { email: email.value, password: pass.value };
}

async function getStoredTokens() {
  const [access, refresh] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_access_token' } }),
    prisma.setting.findUnique({ where: { key: 'bg_refresh_token' } }),
  ]);
  return { access: access?.value ?? null, refresh: refresh?.value ?? null };
}

async function saveTokens(access: string, refresh?: string) {
  const ops: Promise<unknown>[] = [
    prisma.setting.upsert({
      where: { key: 'bg_access_token' },
      create: { key: 'bg_access_token', value: access },
      update: { value: access },
    }),
  ];
  if (refresh) {
    ops.push(
      prisma.setting.upsert({
        where: { key: 'bg_refresh_token' },
        create: { key: 'bg_refresh_token', value: refresh },
        update: { value: refresh },
      }),
    );
  }
  await Promise.all(ops);
}

// Returns a valid access token, refreshing or re-logging in as needed.
export async function GET(_req: NextRequest) {
  const creds = await getCreds();
  if (!creds) return new Response('BuyingGroup not configured', { status: 400 });

  const { access, refresh } = await getStoredTokens();

  // Try refresh first if we have a refresh token
  if (refresh) {
    try {
      const data = await refreshToken(refresh);
      await saveTokens(data.access);
      return Response.json({ access: data.access });
    } catch {
      // Fall through to full login
    }
  }

  // Full login
  try {
    const tokens = await login(creds);
    await saveTokens(tokens.access, tokens.refresh);
    return Response.json({ access: tokens.access });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
