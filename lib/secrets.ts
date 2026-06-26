import crypto from 'node:crypto';

// Symmetric envelope encryption for sensitive Setting values (CC/BG/BFMR
// passwords, etc.). The key comes from EXTENSION_DATA_KEY in the tracker
// env — 64 hex chars (= 32 bytes) for AES-256-GCM. If the env var is
// unset, encrypt/decrypt are no-ops so the install keeps working until
// the user generates a key. Once the key is set, every future write
// goes through ciphertext, and legacy plaintext rows are decrypted as
// themselves until they're rewritten.
//
// On-disk format: "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>".
// Versioned prefix lets us rotate the algorithm without breaking
// older rows.

const PREFIX = 'v1:';

// Settings keys whose value should be encrypted at rest. Anything not in
// this set passes through unchanged (e.g. cc_email, cc_seller_id,
// pushover_user_key — those are identifiers, not secrets).
export const SENSITIVE_SETTING_KEYS = new Set([
  'cc_password',
  'bg_password',
  'bfmr_password',
  'bigsky_password',
  'costco_password',
  'pushover_app_token',
]);

function getKey(): Buffer | null {
  const hex = process.env.EXTENSION_DATA_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.warn('[secrets] EXTENSION_DATA_KEY must be 64 hex chars (= 32 bytes). Encryption disabled.');
    return null;
  }
  return Buffer.from(hex, 'hex');
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSetting(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSetting(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) {
    // Ciphertext on disk but no key configured — log and surface as empty
    // so callers don't think the plaintext password is `v1:…`.
    console.warn('[secrets] encrypted value found but EXTENSION_DATA_KEY is unset; returning empty');
    return '';
  }
  const [, ivB64, tagB64, ctB64] = value.split(':');
  if (!ivB64 || !tagB64 || !ctB64) {
    console.warn('[secrets] malformed ciphertext, returning empty');
    return '';
  }
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn('[secrets] decrypt failed:', e);
    return '';
  }
}
