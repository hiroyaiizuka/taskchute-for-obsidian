/**
 * Field migration utilities for backward compatibility
 * Provides a compatibility layer between old (開始時刻) and new (scheduled_time) field names
 */

export interface FieldMigrationConfig {
  preferNew?: boolean; // Whether to prefer new field names when creating/updating
}

/**
 * Gets scheduled time from frontmatter, supporting both old and new field names
 * @param frontmatter The task frontmatter object
 * @returns The scheduled time value or undefined
 */
export function getScheduledTime(frontmatter: Record<string, unknown> | undefined | null): string | undefined {
  // Null/undefined check
  if (!frontmatter) {
    return undefined;
  }

  // Support both field names, prioritizing new format
  const value = frontmatter.scheduled_time || frontmatter['開始時刻'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Sets scheduled time in frontmatter with migration support
 * @param frontmatter The task frontmatter object to modify
 * @param value The scheduled time value
 * @param config Migration configuration
 */
export function setScheduledTime(
  frontmatter: Record<string, unknown> | undefined | null,
  value: string | undefined,
  config: FieldMigrationConfig = {}
): void {
  // Null/undefined check
  if (!frontmatter) {
    return;
  }

  if (value === undefined || value === '') {
    // Remove both fields when clearing
    delete frontmatter.scheduled_time;
    delete frontmatter['開始時刻'];
    return;
  }

  if (config.preferNew) {
    // New format: use scheduled_time and remove old field
    frontmatter.scheduled_time = value;
    delete frontmatter['開始時刻'];
  } else {
    // Legacy format: keep using 開始時刻 for backward compatibility
    frontmatter['開始時刻'] = value;
    // Don't remove scheduled_time if it exists (read-only migration)
  }
}