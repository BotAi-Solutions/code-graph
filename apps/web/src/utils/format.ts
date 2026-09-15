/** Formatting helpers shared by the inspector and the project header. */

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${String(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** Shows the tail of a long path, which is the part that identifies it. */
export function shortenPath(filePath: string, maxLength = 48): string {
  if (filePath.length <= maxLength) return filePath;
  return `…${filePath.slice(filePath.length - maxLength + 1)}`;
}

/** "3 minutes ago" — relative time for the last-analysed column. */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';

  const elapsedMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(elapsedMs)) return 'unknown';
  if (elapsedMs < 45_000) return 'just now';

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 3600_000],
    ['month', 30 * 24 * 3600_000],
    ['day', 24 * 3600_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (elapsedMs >= ms) return formatter.format(-Math.round(elapsedMs / ms), unit);
  }
  return 'just now';
}
