// Remote scrape config for the browser extension: DATA only (CSS selectors, label
// strings, regex sources, URL patterns, timeouts). MV3 forbids remote code, so
// logic stays in the extension and a selector or page-pattern fix ships as a
// tracker deploy. The file is config/scrape-config.json; the extension bundles
// an exact copy (src/lib/scrapeConfig.default.json) as its last-resort default,
// and the two must match. The validator below is the same one the extension
// runs (src/lib/scrapeConfig.ts): keep the rules in step.
import { createHash } from 'node:crypto';
import { verifyExtensionSecret } from './extensionAuth.ts';

export const SCRAPE_CATEGORIES = ['selectors', 'labels', 'patterns', 'urls', 'timeoutsMs'] as const;

export interface ScrapeSite {
  selectors: Record<string, string>;
  labels: Record<string, string>;
  patterns: Record<string, string>;
  urls: Record<string, string>;
  timeoutsMs: Record<string, number>;
}
export interface ScrapeConfig {
  version: number;
  sites: Record<string, ScrapeSite>;
}
export type ValidationResult = { ok: true; config: ScrapeConfig } | { ok: false; error: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SITE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_STRING = 20_000;
const MAX_MS = 86_400_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks an unknown value against the schema and returns a clean copy (only
 * known keys). Rejects: unknown top-level or per-site keys, functions or any
 * non-string value in a string category, non-integer timeouts, and regex
 * sources that do not compile.
 */
export function validateScrapeConfig(raw: unknown): ValidationResult {
  const fail = (error: string): ValidationResult => ({ ok: false, error });
  if (!isPlainObject(raw)) return fail('config must be an object');
  for (const k of Object.keys(raw)) {
    if (k !== 'version' && k !== 'sites') return fail(`unknown top-level key "${k}"`);
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fail('version must be a positive integer');
  if (!isPlainObject(raw.sites)) return fail('sites must be an object');
  const sites: Record<string, ScrapeSite> = {};
  for (const [siteKey, siteRaw] of Object.entries(raw.sites)) {
    if (!SITE_RE.test(siteKey)) return fail(`bad site key "${siteKey}"`);
    if (!isPlainObject(siteRaw)) return fail(`site "${siteKey}" must be an object`);
    for (const k of Object.keys(siteRaw)) {
      if (!(SCRAPE_CATEGORIES as readonly string[]).includes(k)) return fail(`site "${siteKey}": unknown key "${k}"`);
    }
    const site: ScrapeSite = { selectors: {}, labels: {}, patterns: {}, urls: {}, timeoutsMs: {} };
    for (const cat of SCRAPE_CATEGORIES) {
      const group = siteRaw[cat];
      if (!isPlainObject(group)) return fail(`site "${siteKey}": ${cat} must be an object`);
      for (const [name, value] of Object.entries(group)) {
        const where = `${siteKey}.${cat}.${name}`;
        if (!NAME_RE.test(name)) return fail(`bad entry name "${where}"`);
        if (cat === 'timeoutsMs') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MS) return fail(`${where} must be an integer 0..${MAX_MS}`);
          site.timeoutsMs[name] = value;
          continue;
        }
        if (typeof value !== 'string') return fail(`${where} must be a string`);
        if (value.length > MAX_STRING) return fail(`${where} is too long`);
        if (cat === 'patterns') {
          try { new RegExp(value); } catch { return fail(`${where} is not a valid regex`); }
        }
        site[cat][name] = value;
      }
    }
    sites[siteKey] = site;
  }
  return { ok: true, config: { version, sites } };
}

// ---- serving ----

export type LoadedScrapeConfig =
  | { ok: true; config: ScrapeConfig; body: string; etag: string }
  | { ok: false; error: string };

/** Strong ETag from the version and a hash of the exact body served. */
export function scrapeConfigEtag(version: number, body: string): string {
  return `"${version}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
}

/** Validates once and prepares the body and ETag. An invalid config logs one clear line and is never served. */
export function loadScrapeConfig(raw: unknown, log: (msg: string) => void = console.error): LoadedScrapeConfig {
  const v = validateScrapeConfig(raw);
  if (!v.ok) {
    log(`[scrape-config] INVALID config/scrape-config.json, serving 500 (extensions keep their cache): ${v.error}`);
    return { ok: false, error: v.error };
  }
  const body = JSON.stringify(v.config);
  return { ok: true, config: v.config, body, etag: scrapeConfigEtag(v.config.version, body) };
}

/** True when an If-None-Match header names this ETag (weak prefix ignored; `*` matches). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(part => {
    const t = part.trim().replace(/^W\//, '');
    return t === '*' || t === etag;
  });
}

const CACHE_CONTROL = 'no-cache';

/** GET /api/extension/scrape-config: secret guard like the other extension routes, then 304/200/500. */
export function scrapeConfigResponse(req: Request, loaded: LoadedScrapeConfig): Response {
  if (!verifyExtensionSecret(req)) return Response.json({ error: 'extension secret missing or invalid' }, { status: 401 });
  if (!loaded.ok) return Response.json({ error: 'scrape config invalid' }, { status: 500 });
  const headers = { ETag: loaded.etag, 'Cache-Control': CACHE_CONTROL };
  if (etagMatches(req.headers.get('If-None-Match'), loaded.etag)) return new Response(null, { status: 304, headers });
  return new Response(loaded.body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
}
