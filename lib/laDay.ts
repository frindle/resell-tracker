// Los Angeles calendar-day helpers for the digest (lib/digestLines.ts, lib/resetLines.ts).

// Days are LA calendar days, worked out explicitly: the container's own time
// zone isn't set, and the queue reads "day" in LA time.
const laFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function la(at: Date): { day: string; hour: number; wallAsUtc: number } {
  const p: Record<string, string> = {};
  for (const x of laFmt.formatToParts(at)) p[x.type] = x.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    wallAsUtc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
  };
}

export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant LA calendar day `day` (YYYY-MM-DD) starts. DST-safe: it changes at 02:00, never midnight. */
export function laMidnight(day: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let t = utcMidnight;
  for (let i = 0; i < 2; i++) t = utcMidnight - (la(new Date(t)).wallAsUtc - t);
  return new Date(t);
}

