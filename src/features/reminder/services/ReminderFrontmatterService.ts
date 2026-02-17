/**
 * ReminderFrontmatterService - Handles reminder data in frontmatter
 *
 * Provides utility functions for reading and writing reminder_time
 * to task frontmatter. The reminder_time is stored in HH:mm format
 * representing the exact time when the notification should fire.
 */

const REMINDER_TIME_KEY = 'reminder_time';

/**
 * Normalize a reminder_time value to HH:mm string format.
 *
 * Handles:
 * - String values: validates HH:mm format and normalizes to zero-padded hours
 * - Number values: converts YAML sexagesimal-parsed integers back to HH:mm
 *   (e.g., 595 → "09:55", 615 → "10:15")
 * - Invalid values: returns undefined
 *
 * @param value - The raw reminder_time value (may be string, number, or other)
 * @returns Normalized HH:mm string, or undefined if invalid
 */
export function normalizeReminderTime(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return undefined;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value < 1440) {
    const hh = String(Math.floor(value / 60)).padStart(2, '0');
    const mm = String(value % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  return undefined;
}

/**
 * Get the reminder_time value from frontmatter.
 *
 * @param frontmatter - The frontmatter object
 * @returns The reminder time string (HH:mm) if valid, null otherwise
 */
export function getReminderTimeFromFrontmatter(
  frontmatter: Record<string, unknown> | undefined
): string | null {
  if (!frontmatter) {
    return null;
  }

  return normalizeReminderTime(frontmatter[REMINDER_TIME_KEY]) ?? null;
}

/**
 * Set the reminder_time value in frontmatter.
 *
 * @param frontmatter - The frontmatter object to modify
 * @param time - The time string in HH:mm format
 */
export function setReminderTimeToFrontmatter(
  frontmatter: Record<string, unknown>,
  time: string
): void {
  frontmatter[REMINDER_TIME_KEY] = time;
}

/**
 * Remove the reminder_time value from frontmatter.
 *
 * @param frontmatter - The frontmatter object to modify
 */
export function clearReminderFromFrontmatter(
  frontmatter: Record<string, unknown>
): void {
  delete frontmatter[REMINDER_TIME_KEY];
}
