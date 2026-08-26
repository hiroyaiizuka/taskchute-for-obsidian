/**
 * The review file name is stored as a whole pattern, but the user only edits
 * the part in front of the date. These two functions are the seam between the
 * two representations.
 */

const DATE_SUFFIX = "{{date}}.md"
const DEFAULT_PREFIX = "Review - "

export const DEFAULT_REVIEW_FILE_NAME_PATTERN = `${DEFAULT_PREFIX}${DATE_SUFFIX}`

/** The editable prefix of a stored pattern. */
export function reviewFileNamePrefix(pattern: string | undefined): string {
  const normalized =
    !pattern || pattern.trim().length === 0
      ? DEFAULT_REVIEW_FILE_NAME_PATTERN
      : pattern
  return normalized.endsWith(DATE_SUFFIX)
    ? normalized.slice(0, -DATE_SUFFIX.length)
    : normalized
}

/**
 * Puts an edited prefix back into a full pattern. A blank prefix falls back to
 * the default rather than producing a file named just by its date.
 */
export function reviewFileNamePatternFromPrefix(prefix: string): string {
  const base = prefix.trim().length === 0 ? DEFAULT_PREFIX : prefix
  return `${base}${DATE_SUFFIX}`
}
