import type { SessionFileSystem } from './AgentSessionTypes'

/** Bytes read from the start of a session file (the first prompt and the folder). */
export const HEAD_BYTES = 64 * 1024
/** Bytes read from the end (the latest title and the last messages). */
export const TAIL_BYTES = 256 * 1024

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): JsonRecord[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) records.push(parsed)
    } catch {
      // A line in a format this plugin does not know: skip it.
    }
  }
  return records
}

/**
 * The JSON lines at the start and at the end of a session file, without
 * reading the whole file (Claude Code sessions can run to tens of MB). A
 * line cut by either read is dropped. A small file is read once and both
 * ends are the whole file.
 */
export async function readJsonLineEnds(
  fs: SessionFileSystem,
  path: string,
  size: number,
): Promise<{ head: JsonRecord[]; tail: JsonRecord[] }> {
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    const all = parseLines(await fs.readRange(path, 0, size), false, false)
    return { head: all, tail: all }
  }
  const head = parseLines(await fs.readRange(path, 0, HEAD_BYTES), false, true)
  const tail = parseLines(await fs.readRange(path, size - TAIL_BYTES, TAIL_BYTES), true, false)
  return { head, tail }
}

/** A small text file read whole, or null when missing or too big to be what it should. */
export async function readSmallText(
  fs: SessionFileSystem,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  const stat = await fs.stat(path)
  if (!stat || stat.isDirectory || stat.size > maxBytes) return null
  try {
    return await fs.readRange(path, 0, stat.size)
  } catch {
    return null
  }
}

/** Collapses whitespace and cuts a text for a one-line preview. */
export function preview(text: string, max = 240): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
