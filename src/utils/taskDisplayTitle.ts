/**
 * Canonical title rule shared by task loading and Obsidian-link suggestions.
 *
 * `name` is intentionally not treated as a task title. It is a generic
 * frontmatter property and historically has not affected TaskData display;
 * suggesting it would therefore create an exact-match value that never runs.
 */
export function resolveTaskDisplayTitle(
  frontmatter: unknown,
  ...fallbacks: unknown[]
): string | undefined {
  const metadata = isRecord(frontmatter) ? frontmatter : undefined
  const candidates = [metadata?.['title'], ...fallbacks]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim()
    if (normalized.length > 0) return normalized
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
