/** A decimal string ("-1,234.5", "12", "+3.07") to integer cents without going through floats. null when not a number. */
export function decimalToCents(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, '').replace(/^\$/, '');
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const frac = (m[3] ?? '');
  // Round half away from zero at the third decimal; providers send 2 or fewer, so this is only a safety net.
  const base = Number(m[2] || '0') * 100 + Number((frac + '00').slice(0, 2));
  const up = frac.length > 2 && frac[2] >= '5' ? 1 : 0;
  const v = base + up;
  return m[1] === '-' ? -v : v;
}
