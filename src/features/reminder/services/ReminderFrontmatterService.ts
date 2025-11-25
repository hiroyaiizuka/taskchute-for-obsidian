/**
 * ReminderFrontmatterService - Handles reminder data in frontmatter
 *
 * Provides utility functions for reading and writing reminder_time
 * to task frontmatter. The reminder_time is stored in HH:mm format
 * representing the exact time when the notification should fire.
 */

const REMINDER_TIME_KEY = 'reminder_time';

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

  const value = frontmatter[REMINDER_TIME_KEY];

  // Must be a string in HH:mm format
  if (typeof value !== 'string') {
    return null;
  }

  // Validate HH:mm format
  if (!/^\d{1,2}:\d{2}$/.test(value)) {
    return null;
  }

  return value;
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
