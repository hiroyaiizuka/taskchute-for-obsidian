/**
 * Session search: the query is split into words with the browser's own
 * Japanese-aware word breaker (Intl.Segmenter, built into Obsidian's
 * Chromium, so no dictionary ships with the plugin), and a session matches
 * when its title, first message or last message contains every word, in any
 * order. Single hiragana (particles such as の, を) are not required.
 */

const PARTICLE = /^[぀-ゟ]$/u

export function searchWords(query: string): string[] {
  const text = query.trim().toLowerCase()
  if (text.length === 0) return []
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  const words = Segmenter
    ? Array.from(new Segmenter('ja', { granularity: 'word' }).segment(text))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
    : text.split(/\s+/u)
  const meaningful = words.filter((word) => word.length > 0 && !PARTICLE.test(word))
  return Array.from(new Set(meaningful.length > 0 ? meaningful : words.filter((word) => word.length > 0)))
}

export function matchesAllWords(haystack: string, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const text = haystack.toLowerCase()
  return words.every((word) => text.includes(word))
}
