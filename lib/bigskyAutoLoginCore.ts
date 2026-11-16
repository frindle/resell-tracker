import { simpleParser } from 'mailparser';
import { parseOrderEmail, htmlToText } from './emailParse.ts';

// BigSky login renewal through the order inbox, without touching the
// database, so it can be tested on its own (lib/bigskyAutoLogin.ts wires it).
//
// BigSky signs in with a 6-digit code it emails to the account address
// (lib/bigsky.ts). When that address also delivers to the user's order inbox
// address, the tracker can ask for a code, read it from the inbox, and sign in
// by itself. The code is never logged or stored.

const BIGSKY_SENDER = /@(?:[a-z0-9-]+\.)*bigskybuyers\.com$/i;

export function isBigSkySender(addresses: readonly string[]): boolean {
  return addresses.some(a => BIGSKY_SENDER.test(a.trim()));
}

/** The 6-digit sign-in code in an email's text. One labelled as a code wins; otherwise the only 6-digit number. */
export function extractOtp(text: string): string | null {
  const t = String(text ?? '');
  const labelled = t.match(/\b(?:code|otp|passcode|verification|one[- ]time)\b[^0-9\n]{0,40}\n?[^0-9\n]{0,40}(?<![\d-])(\d{6})(?![\d-])/i);
  if (labelled) return labelled[1];
  const all = new Set([...t.matchAll(/(?<![\d$.,-])(\d{6})(?![\d.,-])/g)].map(m => m[1]));
  return all.size === 1 ? [...all][0] : null;
}

/** The code from a raw BigSky email, or null for any other mail. Reads addy.io reverse aliases and forwards. */
export async function bigSkyOtpFromRaw(raw: Buffer | string): Promise<string | null> {
  const parsed = await simpleParser(raw);
  const plain = parsed.text ?? '';
  const text = plain || (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
  const p = parseOrderEmail({ subject: parsed.subject ?? '', from: parsed.from?.text ?? '', text });
  if (!isBigSkySender(p.senders)) return null;
  return extractOtp(`${p.subject}\n${p.body}`);
}

export type InboxMessage = { id: string; to: string };

export type BigSkyLoginResult = { cookie: string; expiresAt: string | null };

export type AutoLoginDeps = {
  email: string;
  /** Addresses (or parts of them) this user's inbox mail is sent to. Empty: any. */
  inboxAddresses: readonly string[];
  send: (email: string) => Promise<void>;
  verify: (email: string, otp: string) => Promise<BigSkyLoginResult>;
  list: () => Promise<InboxMessage[]>;
  raw: (id: string) => Promise<Buffer | null>;
  remove: (ids: string[]) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
};

export type AutoLoginOutcome =
  | { ok: true; login: BigSkyLoginResult }
  | { ok: false; reason: 'send-failed' | 'no-code-email' | 'verify-failed'; detail?: string };

export const WAIT_MS = 4 * 60 * 1000;
export const POLL_MS = 10 * 1000;

export async function runBigSkyAutoLogin(d: AutoLoginDeps): Promise<AutoLoginOutcome> {
  const mine = (to: string) => {
    if (!d.inboxAddresses.length) return true;
    const t = to.toLowerCase();
    return d.inboxAddresses.some(a => a && t.includes(a.toLowerCase()));
  };
  // Mail already in the inbox is older than this request; an old code is spent.
  const before = new Set((await d.list()).map(m => m.id));
  const start = d.now();
  try {
    await d.send(d.email);
  } catch (e) {
    return { ok: false, reason: 'send-failed', detail: String(e).slice(0, 160) };
  }

  const checked = new Set<string>();
  while (d.now() - start < (d.waitMs ?? WAIT_MS)) {
    await d.sleep(d.pollMs ?? POLL_MS);
    const fresh = (await d.list()).filter(m => !before.has(m.id) && !checked.has(m.id) && mine(m.to));
    for (const m of fresh) {
      checked.add(m.id);
      const raw = await d.raw(m.id);
      if (!raw) continue;
      const otp = await bigSkyOtpFromRaw(raw).catch(() => null);
      if (!otp) continue;
      // Used once either way; don't leave a sign-in code sitting in the inbox.
      await d.remove([m.id]).catch(() => {});
      try {
        return { ok: true, login: await d.verify(d.email, otp) };
      } catch (e) {
        return { ok: false, reason: 'verify-failed', detail: String(e).slice(0, 160) };
      }
    }
  }
  return { ok: false, reason: 'no-code-email' };
}
