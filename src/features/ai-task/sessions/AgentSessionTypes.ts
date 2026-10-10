/**
 * AI Task - agent session history: shared shapes
 *
 * Each AI CLI keeps its own past sessions on this device (Claude Code under
 * ~/.claude, Codex under ~/.codex, Cursor under ~/.cursor). The history reads
 * those files directly — none of the CLIs offers a machine-readable list —
 * and never copies a conversation: it only keeps a short summary per file
 * for the list, and lets the CLI resume the session itself.
 */

import type { AiTaskHost } from '../types'

/** The few file operations the history needs, all read-only. */
export interface SessionFileSystem {
  homeDirectory(): string | undefined
  listEntries(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null>
  /** Up to `length` bytes from `position`, decoded as UTF-8. */
  readRange(path: string, position: number, length: number): Promise<string>
  /**
   * The rows of a key/value table of a SQLite file (every row, or those whose
   * key is in `keys`); null when it cannot be read. Absent where the runtime
   * has no SQLite reader.
   */
  readSqliteTable?(
    path: string,
    table: { name: string; key: string; value: string },
    keys?: readonly string[],
  ): Promise<Map<string, string | Uint8Array> | null>
}

/** One session file found on disk, before it is read. */
export interface AgentSessionFile {
  host: AiTaskHost
  /** The id the CLI resumes the session by. */
  id: string
  path: string
  size: number
  mtimeMs: number
}

/** What the list shows for one session. */
export interface AgentSessionSummary {
  host: AiTaskHost
  id: string
  path: string
  /** The folder the session ran in. */
  cwd: string
  title: string
  /** The first thing the user asked, when the CLI's files hold it. */
  firstText?: string
  /** The last message of the conversation, when the CLI's files hold it. */
  lastText?: string
  updatedAt: number
}

/** How one agent's sessions are found, read, and resumed. */
export interface AgentSessionSource {
  listFiles(fs: SessionFileSystem): Promise<AgentSessionFile[]>
  /** null when the file cannot be read as a session (unknown or changed format). */
  summarize(fs: SessionFileSystem, file: AgentSessionFile): Promise<AgentSessionSummary | null>
  /** The CLI arguments that resume the session in a terminal. */
  resumeArgs(id: string): string[]
}

/** Joins path parts with the separator the home folder uses. */
export function joinSessionPath(home: string, ...parts: string[]): string {
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return [home.replace(/[\\/]+$/u, ''), ...parts].join(sep)
}
