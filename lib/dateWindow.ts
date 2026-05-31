export type DateWindow = '3m' | '6m' | 'ytd' | '1y' | 'all';

export const DATE_WINDOWS: { value: DateWindow; label: string }[] = [
  { value: '3m', label: 'Last 3 months' },
  { value: '6m', label: 'Last 6 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All time' },
];

export function windowStartDate(w: DateWindow): Date | null {
  if (w === 'all') return null;
  const d = new Date();
  if (w === '3m') d.setMonth(d.getMonth() - 3);
  else if (w === '6m') d.setMonth(d.getMonth() - 6);
  else if (w === 'ytd') return new Date(`${d.getFullYear()}-01-01`);
  else if (w === '1y') d.setFullYear(d.getFullYear() - 1);
  return d;
}

export function windowStartIso(w: DateWindow): string | undefined {
  const d = windowStartDate(w);
  return d ? d.toISOString().slice(0, 10) : undefined;
}
