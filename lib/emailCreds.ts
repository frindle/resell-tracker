import { getSetting } from '@/lib/db';
import type { EmailCredentials } from '@/lib/emailSync';

// The shared order inbox is one Gmail account for every tracker user,
// stored as global settings (userId null). A user's own Gmail
// (gmail_address / gmail_app_password) is the fallback for installs that
// have not set one up.
export const INBOX_ADDRESS_KEY = 'email_inbox_address';
export const INBOX_PASSWORD_KEY = 'email_inbox_app_password';

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

export async function orderInboxCreds(userId: number | null): Promise<{ creds: EmailCredentials; shared: boolean } | null> {
  const shared = await sharedInboxCreds();
  if (shared) return { creds: shared, shared: true };
  const own = await personalGmailCreds(userId);
  return own ? { creds: own, shared: false } : null;
}
