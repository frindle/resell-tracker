import { getSetting } from '@/lib/db';
import type { EmailCredentials } from '@/lib/emailSync';
import type { CloudflareCreds } from '@/lib/emailCloudflare';

// The shared order inbox is one Gmail account for every tracker user,
// stored as global settings (userId null). A user's own Gmail
// (gmail_address / gmail_app_password) is the fallback for installs that
// have not set one up.
export const INBOX_ADDRESS_KEY = 'email_inbox_address';
export const INBOX_PASSWORD_KEY = 'email_inbox_app_password';

// Which source feeds the shared inbox: Gmail over IMAP (default) or the
// Cloudflare Email Routing worker. Each source keeps its own settings, so
// switching back and forth loses nothing.
export const INBOX_MODE_KEY = 'email_inbox_mode';
export const CF_URL_KEY = 'email_cf_url';
export const CF_TOKEN_KEY = 'email_cf_token';

export async function cloudflareCreds(): Promise<CloudflareCreds | null> {
  const [url, token] = await Promise.all([getSetting(null, CF_URL_KEY), getSetting(null, CF_TOKEN_KEY)]);
  if (!url?.value || !token?.value) return null;
  return { url: url.value, token: token.value };
}

export async function sharedInboxCreds(): Promise<EmailCredentials | null> {
  const [addr, pass] = await Promise.all([
    getSetting(null, INBOX_ADDRESS_KEY),
    getSetting(null, INBOX_PASSWORD_KEY),
  ]);
  if (!addr?.value || !pass?.value) return null;
  return { address: addr.value, appPassword: pass.value };
}

export async function personalGmailCreds(userId: number | null): Promise<EmailCredentials | null> {
  const [addr, pass] = await Promise.all([
    getSetting(userId, 'gmail_address'),
    getSetting(userId, 'gmail_app_password'),
  ]);
  if (!addr?.value || !pass?.value) return null;
  return { address: addr.value, appPassword: pass.value };
}

export type OrderInbox =
  | { kind: 'gmail'; creds: EmailCredentials; shared: boolean }
  | { kind: 'cloudflare'; cf: CloudflareCreds; shared: true };

export async function orderInboxCreds(userId: number | null): Promise<OrderInbox | null> {
  const mode = await getSetting(null, INBOX_MODE_KEY);
  if (mode?.value === 'cloudflare') {
    const cf = await cloudflareCreds();
    return cf ? { kind: 'cloudflare', cf, shared: true } : null;
  }
  const shared = await sharedInboxCreds();
  if (shared) return { kind: 'gmail', creds: shared, shared: true };
  const own = await personalGmailCreds(userId);
  return own ? { kind: 'gmail', creds: own, shared: false } : null;
}
