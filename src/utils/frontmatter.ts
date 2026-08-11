/**
 * Frontmatter helpers
 * Provides guard patterns for frontmatter operations
 */

/** Safely normalize a frontmatter argument to a plain object. */
export function ensureFrontmatterObject(
  frontmatter: unknown,
): Record<string, unknown> {
  return frontmatter && typeof frontmatter === 'object'
    ? (frontmatter as Record<string, unknown>)
    : {};
}
