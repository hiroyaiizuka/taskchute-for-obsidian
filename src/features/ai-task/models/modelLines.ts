/**
 * AI Task - which models are the newest of their kind
 *
 * A model list from a CLI holds every version of a model, and Cursor's also
 * holds each one at every effort and speed (claude-opus-5-5-low,
 * claude-opus-5-5-high-fast, …). The picker shows only the newest version of
 * each model, once. Both are read from the model ID alone:
 *
 * - variant words (effort, speed, thinking) name a variant, not a model;
 * - numbers are the version; the remaining words are the model's line.
 *
 * So claude-opus-5-5, claude-opus-5 and claude-4.6-opus are the "claude opus"
 * line at 5.5, 5 and 4.6. An ID shaped some other way still lists: at worst a
 * model shows twice, or an older version stays.
 */

/** Words that name a variant of a model (its effort, speed, thinking, context), not a model. */
const VARIANT_WORDS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra',
  'max',
  'fast',
  'thinking',
  'nothinking',
  'no',
  '1m',
])

/** Prefixes a list adds to a model's own name (Cursor's own builds of a model). */
const VENDOR_WORDS = new Set(['cursor'])

const VERSION = /^\d+(?:\.\d+)*$/u

function words(id: string): string[] {
  return id.toLowerCase().split('-').filter((word) => word.length > 0)
}

/** The model an ID names, without its variant words: claude-opus-5-5-high-fast → claude-opus-5-5. */
export function modelFamily(id: string): string {
  return words(id).filter((word) => !VARIANT_WORDS.has(word)).join('-')
}

/** The line and the version of a model ID (see the module comment). */
export function modelLine(id: string): { line: string; version: number[] } {
  const line: string[] = []
  const version: number[] = []
  for (const word of words(id)) {
    if (VERSION.test(word)) version.push(...word.split('.').map(Number))
    else if (!VARIANT_WORDS.has(word) && !VENDOR_WORDS.has(word)) line.push(word)
  }
  return { line: line.sort().join(' '), version }
}

function isNewer(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/** Only the newest version of each line, in the order the list gave them. */
export function newestPerLine<T>(models: readonly T[], idOf: (model: T) => string): T[] {
  const newest = new Map<string, { model: T; version: number[] }>()
  for (const model of models) {
    const { line, version } = modelLine(idOf(model))
    const kept = newest.get(line)
    if (!kept || isNewer(version, kept.version)) newest.set(line, { model, version })
  }
  const keep = new Set(Array.from(newest.values(), (entry) => entry.model))
  return models.filter((model) => keep.has(model))
}

/**
 * One row per model: of its variants, the ID to pass is the plain one when the
 * list has it, else the medium one, else the first that is not a fast build.
 */
export function onePerFamily<T>(models: readonly T[], idOf: (model: T) => string): T[] {
  const families = new Map<string, T[]>()
  for (const model of models) {
    const family = modelFamily(idOf(model))
    const members = families.get(family)
    if (members) members.push(model)
    else families.set(family, [model])
  }
  return Array.from(families.entries(), ([family, members]) => {
    const plain = members.find((model) => idOf(model).toLowerCase() === family)
    const medium = members.find((model) => words(idOf(model)).includes('medium') && !words(idOf(model)).includes('fast'))
    const notFast = members.find((model) => !words(idOf(model)).includes('fast'))
    return plain ?? medium ?? notFast ?? members[0]
  })
}

/**
 * A model's name without the variant words at its end: "Claude Opus 5.5 1M
 * Low" → "Claude Opus 5.5". A note in brackets after them stays: "Claude
 * Fable 5.1 1M Medium (NO ZDR)" → "Claude Fable 5.1 (NO ZDR)".
 */
export function withoutVariantWords(label: string): string {
  const note = /\s*(\([^()]*\))\s*$/u.exec(label)
  const name = (note ? label.slice(0, note.index) : label)
    .replace(/(\s+(?:1M|Low|Medium|High|Extra High|Max|None|Minimal|Fast|Thinking|No Thinking))+\s*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return note ? `${name} ${note[1]}` : name
}
