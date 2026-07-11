/**
 * AI Task - frontmatter reader
 *
 * Pure functions that normalize `ai_task_*` frontmatter fields into an
 * AiTaskConfig. Task-note frontmatter is READ-ONLY for the AI Task feature:
 * this module never mutates its input and never writes back to the note.
 */

import type { AiTaskConfig, AiTaskHost } from '../types'

const VALID_HOSTS: readonly AiTaskHost[] = ['claude', 'codex']

function normalizeHost(value: unknown): AiTaskHost {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    const match = VALID_HOSTS.find((host) => host === normalized)
    if (match) return match
  }
  return 'claude'
}

/**
 * Tokenize a shell-like argument string, honoring single and double quotes.
 * Quotes group whitespace into a single token and may produce empty tokens
 * (e.g. `--flag ""`). Unterminated quotes are treated leniently: the rest of
 * the string becomes part of the current token. Never throws.
 */
function tokenizeArgString(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let sawQuote = false

  const flushToken = (): void => {
    if (current.length > 0 || sawQuote) {
      tokens.push(current)
    }
    current = ''
    sawQuote = false
  }

  for (const char of input) {
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      sawQuote = true
      continue
    }
    if (/\s/.test(char)) {
      flushToken()
      continue
    }
    current += char
  }
  flushToken()

  return tokens
}

function normalizeArgs(value: unknown): string[] {
  if (typeof value === 'string') {
    return tokenizeArgString(value)
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    )
  }
  return []
}

function normalizeCwd(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }
  return undefined
}

/**
 * Read the AI Task configuration from task-note frontmatter.
 * Returns null unless `ai_task` is strictly the boolean `true`.
 */
export function readAiTaskConfig(
  frontmatter: Record<string, unknown> | null | undefined,
): AiTaskConfig | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null
  if (frontmatter['ai_task'] !== true) return null

  return {
    host: normalizeHost(frontmatter['ai_task_host']),
    args: normalizeArgs(frontmatter['ai_task_args']),
    cwd: normalizeCwd(frontmatter['ai_task_cwd']),
  }
}
