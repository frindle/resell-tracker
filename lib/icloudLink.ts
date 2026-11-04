// Lists the photos behind a public iCloud photo link, for the "Import from an
// iCloud link" box. Two kinds of link, both Apple's UNDOCUMENTED web APIs
// (the same ones icloud.com uses), so this can break if Apple changes them:
//
//  - iCloud Link (Photos > Share > Copy iCloud Link):
//      https://share.icloud.com/photos/<shortGUID>
//    CloudKit: records/resolve -> anonymous grant -> shared/records/query.
//  - Shared Album public website:
//      https://www.icloud.com/sharedalbum/#<token>
//    sharedstreams: webstream -> webasseturls.
//
// Protocols per home-screens/home-screens src/lib/icloud-link.ts and
// icloud-album.ts, ghostops/ICloud-Shared-Album, pyicloud (field names).
// Download addresses are signed and short-lived (~1 h), so the page imports
// right after listing. Videos are skipped.

export type IcloudItem = { key: string; name: string; takenAt: string | null; downloadUrl: string };

export type ParsedLink = { kind: 'link'; id: string } | { kind: 'album'; token: string };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAX_ITEMS = 500;

export function parseIcloudLink(raw: string): ParsedLink | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const hash = u.hash.replace(/^#/, '');
  if (host === 'www.icloud.com' || host === 'icloud.com') {
    if (/^\/sharedalbum\b/.test(u.pathname) && /^[A-Za-z0-9]{10,}$/.test(hash)) return { kind: 'album', token: hash };
    if (/^\/photos\/?$/.test(u.pathname) && /^[A-Za-z0-9_-]{10,}$/.test(hash)) return { kind: 'link', id: hash };
  }
  if (host === 'share.icloud.com') {
    const m = u.pathname.match(/^\/photos\/([A-Za-z0-9_-]{10,})\/?$/);
    if (m) return { kind: 'link', id: m[1] };
  }
  return null;
}

/** Only Apple's photo hosts, over https: the fetch step downloads nothing else. */
export function isAllowedIcloudDownload(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return h.endsWith('.icloud-content.com') || h.endsWith('.icloud.com') || h === 'icloud-content.com';
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Shared Album partition host from the token ("p23-sharedstreams.icloud.com"). */
export function albumHost(token: string): string {
  const chars = token[0] === 'A' ? token.slice(1, 2) : token.slice(1, 3);
  let v = 0;
  for (const c of chars) v = v * 62 + B62.indexOf(c);
  return `p${String(v).padStart(2, '0')}-sharedstreams.icloud.com`;
}

type Derivative = { checksum?: string; fileSize?: string | number };
type AlbumPhoto = { photoGuid: string; mediaAssetType?: string; dateCreated?: string; derivatives?: Record<string, Derivative> };

/** Largest image derivative: keys are pixel heights; fall back to file size. */
export function bestDerivative(derivs: Record<string, Derivative> = {}): Derivative | null {
  const entries = Object.entries(derivs).filter(([, d]) => d?.checksum);
  if (!entries.length) return null;
  const numeric = entries.filter(([k]) => /^\d+$/.test(k));
  const pool = numeric.length ? numeric.sort((a, b) => Number(b[0]) - Number(a[0])) : entries.sort((a, b) => Number(b[1].fileSize ?? 0) - Number(a[1].fileSize ?? 0));
  return pool[0][1];
}

async function postJson(url: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': UA, ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
}

async function listAlbum(token: string): Promise<IcloudItem[]> {
  const hdr = { Origin: 'https://www.icloud.com', Referer: 'https://www.icloud.com/sharedalbum/' };
  let host = albumHost(token);
  let res = await postJson(`https://${host}/${token}/sharedstreams/webstream`, { streamCtag: null }, hdr);
  if (res.status === 330) {
    const moved = (await res.json().catch(() => ({})))['X-Apple-MMe-Host'];
    if (typeof moved !== 'string' || !/^[a-z0-9-]+\.icloud\.com$/.test(moved)) throw new Error('iCloud sent an unexpected redirect');
    host = moved;
    res = await postJson(`https://${host}/${token}/sharedstreams/webstream`, { streamCtag: null }, hdr);
  }
  if (res.status === 404 || res.status === 410) throw new Error('That shared album is gone or its public website is turned off');
  if (!res.ok) throw new Error(`iCloud returned HTTP ${res.status}`);
  const stream = await res.json() as { photos?: AlbumPhoto[] };

  const photos = (stream.photos ?? []).filter(p => p.mediaAssetType !== 'video').slice(0, MAX_ITEMS);
  const chosen = photos.map(p => ({ p, d: bestDerivative(p.derivatives) })).filter(x => x.d?.checksum);

  const urls: Record<string, { url_location: string; url_path: string }> = {};
  for (let i = 0; i < chosen.length; i += 25) {
    const r = await postJson(`https://${host}/${token}/sharedstreams/webasseturls`, { photoGuids: chosen.slice(i, i + 25).map(x => x.p.photoGuid) }, hdr);
    if (!r.ok) throw new Error(`iCloud returned HTTP ${r.status} listing download addresses`);
    Object.assign(urls, ((await r.json()) as { items?: typeof urls }).items ?? {});
  }

  const out: IcloudItem[] = [];
  for (const { p, d } of chosen) {
    const loc = urls[d!.checksum!];
    if (!loc) continue;
    const date = p.dateCreated ? new Date(p.dateCreated) : null;
    out.push({
      key: p.photoGuid,
      name: `icloud-${p.photoGuid.slice(0, 8)}.jpg`,
      takenAt: date && !isNaN(date.getTime()) ? date.toISOString() : null,
      downloadUrl: `https://${loc.url_location}${loc.url_path}`,
    });
  }
  return out;
}

type CkField = { value?: unknown };
type CkRecord = { recordName: string; recordType: string; fields?: Record<string, CkField> };
type CkAsset = { downloadURL?: string; size?: number };

const WEB_SAFE = new Set(['public.jpeg', 'public.png']);

/** One import item from a CPLMaster record, or null for videos / no image. */
export function itemFromMaster(rec: CkRecord, takenAt: string | null): IcloudItem | null {
  const f = rec.fields ?? {};
  const val = <T>(k: string) => f[k]?.value as T | undefined;
  const itemType = val<string>('itemType') ?? '';
  if (/movie|mpeg-4|video/i.test(itemType)) return null;

  let name = '';
  const enc = val<string>('filenameEnc');
  if (enc) { try { name = Buffer.from(enc, 'base64').toString('utf8'); } catch { name = ''; } }
  if (!name || /[\/\\]/.test(name)) name = `icloud-${rec.recordName.slice(0, 8)}.jpg`;

  // The original when it is JPEG/PNG; otherwise (HEIC etc.) Apple's full-size JPEG.
  const origType = val<string>('resOriginalFileType') ?? '';
  const original = val<CkAsset>('resOriginalRes');
  const jpeg = val<CkAsset>('resJPEGFullRes') ?? val<CkAsset>('resJPEGMedRes');
  let asset: CkAsset | undefined;
  if (original?.downloadURL && WEB_SAFE.has(origType)) asset = original;
  else if (jpeg?.downloadURL) { asset = jpeg; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
  else if (original?.downloadURL) asset = original;
  if (!asset?.downloadURL) return null;

  // CloudKit asset URLs may carry a ${f} filename placeholder.
  const downloadUrl = asset.downloadURL.replace('${f}', encodeURIComponent(name));
  return { key: rec.recordName, name, takenAt, downloadUrl };
}

async function listLink(id: string): Promise<IcloudItem[]> {
  const res = await postJson(
    'https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve?remapEnums=true',
    { shortGUIDs: [{ value: id, shouldFetchRootRecord: true }] },
  );
  if (res.status >= 500) throw new Error(`iCloud is having trouble (HTTP ${res.status}); try again shortly`);
  const resolved = await res.json().catch(() => ({})) as { results?: { zoneID?: unknown; anonymousPublicAccess?: { databasePartition?: string; token?: string } }[] };
  const r0 = resolved.results?.[0];
  const grant = r0?.anonymousPublicAccess;
  if (!res.ok || !r0?.zoneID || !grant?.token || !grant.databasePartition) throw new Error('That iCloud link has expired or was turned off');
  let part: URL;
  try { part = new URL(grant.databasePartition); } catch { throw new Error('iCloud sent an unexpected address'); }
  if (part.protocol !== 'https:' || !part.hostname.endsWith('.icloud.com')) throw new Error('iCloud sent an unexpected address');
  const base = `https://${part.hostname}/database/1/com.apple.photos.cloud/production/shared/records/query`
    + `?publicAccessAuthToken=${encodeURIComponent(grant.token)}&remapEnums=true&getCurrentSyncToken=true`;

  const masters: CkRecord[] = [];
  const dates = new Map<string, string>(); // master recordName -> capture date
  let marker: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = await postJson(base, {
      query: { recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted' },
      zoneID: r0.zoneID,
      ...(marker ? { continuationMarker: marker } : {}),
    });
    if (!q.ok) throw new Error(`iCloud returned HTTP ${q.status} listing the photos`);
    const body = await q.json() as { records?: CkRecord[]; continuationMarker?: string };
    for (const rec of body.records ?? []) {
      if (rec.recordType === 'CPLMaster') masters.push(rec);
      else if (rec.recordType === 'CPLAsset') {
        const ref = (rec.fields?.masterRef?.value as { recordName?: string } | undefined)?.recordName;
        const ms = rec.fields?.assetDate?.value;
        if (ref && typeof ms === 'number') dates.set(ref, new Date(ms).toISOString());
      }
    }
    marker = body.continuationMarker;
    if (!marker || masters.length >= MAX_ITEMS) break;
  }
  return masters.slice(0, MAX_ITEMS)
    .map(m => itemFromMaster(m, dates.get(m.recordName) ?? null))
    .filter((x): x is IcloudItem => x != null && isAllowedIcloudDownload(x.downloadUrl));
}

export async function listIcloudLink(raw: string): Promise<IcloudItem[]> {
  const parsed = parseIcloudLink(raw);
  if (!parsed) throw new Error('Paste an iCloud photo link (share.icloud.com/photos/…) or a Shared Album link (icloud.com/sharedalbum/#…)');
  const items = parsed.kind === 'album' ? await listAlbum(parsed.token) : await listLink(parsed.id);
  return items.filter(i => isAllowedIcloudDownload(i.downloadUrl));
}
