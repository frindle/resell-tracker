// Single source of truth for "is this overdue" — day granularity, local
// time, so an order due 7/12 doesn't flag overdue until 7/13. A raw
// timestamp comparison (overdueAt < now) flags it hours early, same day,
// which is what made the homepage and /orders disagree.
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isOverdue(overdueAt: string | Date): boolean {
  const dateStr = typeof overdueAt === 'string' ? overdueAt.split('T')[0] : localDateStr(overdueAt);
  return localDateStr() > dateStr;
}
