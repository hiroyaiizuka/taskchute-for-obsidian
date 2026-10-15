/**
 * AI Task - the whole conversation of a session, as text to search
 *
 * Full-text search reads every line of a session file once, which for a
 * Claude Code session can mean tens of MB, almost all of it tool output.
 * The file is read a chunk at a time (never whole), and a line is only parsed
 * when a cheap look at the raw text says it may hold a message: JSON.parse is
 * what makes a full read slow, and a tool result is never searched.
 */

import type { SessionFileSystem } from './AgentSessionTypes'
import { isRecord, type JsonRecord } from './jsonLines'

/** Bytes read at a time; grows for a line longer than this. */
export const TEXT_CHUNK_BYTES = 1024 * 1024

const encoder = new TextEncoder()

/**
 * Calls `onRecord` for each JSON line of the file that `accept` lets through,
 * reading `chunkBytes` at a time. A chunk ends at its last complete line, so
 * neither a line nor a multibyte character is ever cut.
 */
export async function forEachJsonLine(
  fs: SessionFileSystem,
  path: string,
  size: number,
  accept: (rawLine: string) => boolean,
  onRecord: (record: JsonRecord) => void,
  chunkBytes = TEXT_CHUNK_BYTES,
): Promise<void> {
  const handle = (line: string) => {
    if (line.length === 0 || !accept(line)) return
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) onRecord(parsed)
    } catch {
      // A line in a format this plugin does not know: skip it.
    }
  }
  let position = 0
  let length = chunkBytes
  while (position < size) {
    const last = position + length >= size
    const text = await fs.readRange(path, position, last ? size - position : length)
    if (last) {
      for (const line of text.split('\n')) handle(line)
      return
    }
    const end = text.lastIndexOf('\n')
    if (end < 0) {
      // One line longer than the chunk: read more of it at once.
      length *= 2
      continue
    }
    const complete = text.slice(0, end)
    for (const line of complete.split('\n')) handle(line)
    position += encoder.encode(complete).length + 1
    length = chunkBytes
  }
}

/** Joins the messages of a conversation into one searchable text. */
export function joinMessages(messages: readonly string[]): string {
  return messages.map((message) => message.trim()).filter((message) => message.length > 0).join('\n')
}

/** The text around the first place `word` occurs, for the list. */
export function snippetAround(text: string, lower: string, word: string, before = 40, after = 100): string | undefined {
  const at = lower.indexOf(word)
  if (at < 0) return undefined
  // toLowerCase keeps the length for the scripts that matter here; if it did
  // not, cut the lowered text rather than misplace the cut in the original.
  const source = lower.length === text.length ? text : lower
  const start = Math.max(0, at - before)
  const end = Math.min(source.length, at + word.length + after)
  const flat = source.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${flat}${end < source.length ? '…' : ''}`
}
