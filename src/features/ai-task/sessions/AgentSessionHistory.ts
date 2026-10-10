/**
 * AI Task - the session history list
 *
 * Lists the past sessions of every agent that ran in the vault's folder,
 * newest first, a page at a time. Each refresh lists the CLIs' session files
 * (cheap: names, sizes, times); a file is only read when its page is asked
 * for, and its summary is reused until the file changes. Sessions whose
 * folder is gone are left out, and so are archived ones unless asked for.
 */

import type { AiTaskHost } from '../types'
import type { AgentSessionFile, AgentSessionSource, AgentSessionSummary, SessionFileSystem } from './AgentSessionTypes'
import { SessionArchiveStore, sessionArchiveKey } from './SessionArchiveStore'
import { matchesAllWords, searchWords } from './sessionSearch'

export interface AgentSessionPageRequest {
  /** The folder whose sessions to list (the vault's). */
  folder: string
  query?: string
  /** true lists only archived sessions; false only the others. */
  archived?: boolean
  /** Where the previous page stopped; omit for the first page. */
  cursor?: number
  limit?: number
}

export interface AgentSessionListItem extends AgentSessionSummary {
  archived: boolean
}

export interface AgentSessionPage {
  items: AgentSessionListItem[]
  /** null when there is nothing more to list. */
  nextCursor: number | null
}

export const SESSION_PAGE_SIZE = 50

/** Folder paths compared the way the OS does: `\\` as `/`, case-blind on Windows drives. */
function normalizeFolder(path: string): string {
  const slashed = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(slashed) ? slashed.toLowerCase() : slashed
}

export function isInsideFolder(cwd: string, folder: string): boolean {
  const inner = normalizeFolder(cwd)
  const outer = normalizeFolder(folder)
  return outer.length > 0 && (inner === outer || inner.startsWith(`${outer}/`))
}

export class AgentSessionHistory {
  private files: AgentSessionFile[] = []
  private readonly summaries = new Map<string, { size: number; mtimeMs: number; summary: AgentSessionSummary | null }>()
  private readonly folderExists = new Map<string, boolean>()

  constructor(
    private readonly fs: SessionFileSystem,
    /** One reader per agent that keeps sessions. */
    private readonly sources: ReadonlyMap<AiTaskHost, AgentSessionSource>,
    private readonly archive: SessionArchiveStore,
  ) {}

  /** Lists the session files again (names, sizes and times only). */
  async refresh(): Promise<void> {
    const lists = await Promise.all(
      Array.from(this.sources.values()).map((source) =>
        source.listFiles(this.fs).catch(() => [] as AgentSessionFile[]),
      ),
    )
    this.files = lists.flat().sort((left, right) => right.mtimeMs - left.mtimeMs)
    this.folderExists.clear()
    const existing = new Set(this.files.map((file) => sessionArchiveKey(file.host, file.id)))
    this.archive.prune(existing)
    for (const path of Array.from(this.summaries.keys())) {
      if (!this.files.some((file) => file.path === path)) this.summaries.delete(path)
    }
  }

  async page(request: AgentSessionPageRequest): Promise<AgentSessionPage> {
    const words = searchWords(request.query ?? '')
    const limit = request.limit ?? SESSION_PAGE_SIZE
    const items: AgentSessionListItem[] = []
    for (let index = request.cursor ?? 0; index < this.files.length; index += 1) {
      const file = this.files[index]
      const archived = this.archive.has(sessionArchiveKey(file.host, file.id))
      if (archived !== (request.archived ?? false)) continue
      const summary = await this.summarize(file)
      if (!summary || !isInsideFolder(summary.cwd, request.folder)) continue
      const haystack = [summary.title, summary.firstText ?? '', summary.lastText ?? ''].join('\n')
      if (!matchesAllWords(haystack, words)) continue
      if (!(await this.exists(summary.cwd))) continue
      items.push({ ...summary, archived })
      if (items.length >= limit) {
        return { items, nextCursor: index + 1 < this.files.length ? index + 1 : null }
      }
    }
    return { items, nextCursor: null }
  }

  archiveSession(host: AiTaskHost, id: string): void {
    this.archive.archive(sessionArchiveKey(host, id))
  }

  restoreSession(host: AiTaskHost, id: string): void {
    this.archive.restore(sessionArchiveKey(host, id))
  }

  /**
   * Whether a session can still be resumed: its file and its folder are
   * still there. Checked right before resuming, because a CLI asked for a
   * missing id may report success (Claude Code) or quietly start a new
   * conversation (Cursor) instead of failing.
   */
  async canResume(session: Pick<AgentSessionSummary, 'path' | 'cwd'>): Promise<boolean> {
    const file = await this.fs.stat(session.path)
    const folder = await this.fs.stat(session.cwd)
    return file !== null && !file.isDirectory && folder !== null && folder.isDirectory
  }

  private async summarize(file: AgentSessionFile): Promise<AgentSessionSummary | null> {
    const cached = this.summaries.get(file.path)
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.summary
    const source = this.sources.get(file.host)
    let summary: AgentSessionSummary | null = null
    try {
      summary = source ? await source.summarize(this.fs, file) : null
    } catch {
      summary = null
    }
    this.summaries.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, summary })
    return summary
  }

  private async exists(folder: string): Promise<boolean> {
    const known = this.folderExists.get(folder)
    if (known !== undefined) return known
    const stat = await this.fs.stat(folder)
    const present = stat !== null && stat.isDirectory
    this.folderExists.set(folder, present)
    return present
  }
}
