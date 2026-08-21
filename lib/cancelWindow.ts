// Short human-readable "time left to cancel" string for the orders list
// badge, or null once the window has passed (caller hides the badge).
const CANCEL_WINDOW_MS: Record<string, number> = {
  walmart: 24 * 60 * 60 * 1000,
  amazon: 30 * 60 * 1000,
};

export function cancelWindowRemaining(orderDate: string, platform: string): string | null {
  const windowMs = CANCEL_WINDOW_MS[platform.toLowerCase()];
  if (windowMs == null) return null;

  const deadline = new Date(orderDate).getTime() + windowMs;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;

  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h left to cancel`;

  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes >= 1) return `${minutes}m left to cancel`;

  return '<1m left to cancel';
}
