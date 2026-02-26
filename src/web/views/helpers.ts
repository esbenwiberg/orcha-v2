/**
 * View helpers shared across ETA templates.
 */

/**
 * Format a Date as a human-readable relative time string.
 *
 * Returns:
 *   'just now'   — less than 60 seconds ago
 *   'X min ago'  — less than 60 minutes ago
 *   'X hr ago'   — less than 24 hours ago
 *   'X days ago' — 24 hours or more ago
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hr ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} days ago`;
}
