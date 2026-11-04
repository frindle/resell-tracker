// The Cloudflare Access service token the iOS Shortcut sends to get past
// Access to /api/upload/photo. It is one per install (shared by every user),
// so it is stored with userId null. The secret is encrypted at rest
// (SENSITIVE_SETTING_KEYS) and never returned by any GET; it only goes out
// inside a freshly created upload key's setup code.
//
// Env vars CF_UPLOAD_CLIENT_ID / CF_UPLOAD_CLIENT_SECRET win over the saved one.
import { prisma, getSetting, upsertSetting } from '@/lib/db';

export const CF_ID_KEY = 'cf_upload_client_id';
export const CF_SECRET_KEY = 'cf_upload_client_secret';

export type CfToken = { clientId: string; clientSecret: string; source: 'env' | 'saved' };

export async function getUploadCfToken(): Promise<CfToken | null> {
  const envId = process.env.CF_UPLOAD_CLIENT_ID?.trim();
  const envSecret = process.env.CF_UPLOAD_CLIENT_SECRET?.trim();
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret, source: 'env' };
  const [id, secret] = await Promise.all([getSetting(null, CF_ID_KEY), getSetting(null, CF_SECRET_KEY)]);
  if (id?.value && secret?.value) return { clientId: id.value, clientSecret: secret.value, source: 'saved' };
  return null;
}

export async function saveUploadCfToken(clientId: string, clientSecret: string) {
  await upsertSetting(null, CF_ID_KEY, clientId);
  await upsertSetting(null, CF_SECRET_KEY, clientSecret);
}

export async function clearUploadCfToken() {
  await prisma.setting.deleteMany({ where: { userId: null, key: { in: [CF_ID_KEY, CF_SECRET_KEY] } } });
}

/** "abcd1234….access" — enough to recognise which token is saved. */
export function maskClientId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-7)}` : id;
}
