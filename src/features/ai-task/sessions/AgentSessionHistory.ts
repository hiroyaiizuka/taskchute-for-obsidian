/**
 * AI Task - the session history list
 *
 * Lists the past sessions of every agent that ran in the vault's folder,
 * newest first, a page at a time. Each refresh lists the CLIs' session files
 * (cheap: names, sizes, times); a file is only read when its page is asked
 * for, and its summary is reused until the file changes. Sessions whose
 * folder is gone are left out, and so are archived ones unless asked for.
 *
 * Search covers the whole conversation. Each session's messages are extracted
 * once and kept (SessionTextStore, on this device) until its file changes;
 * prepareSearch extracts the folder's sessions in the background so the first
 * search does not wait for it. A search still extracts whatever is missing.
 */

import type { AiTaskHost } from '../types'
import type { AgentSessionFile, AgentSessionSource, AgentSessionSummary, SessionFileSystem } from './AgentSessionTypes'
import { SessionArchiveStore, sessionArchiveKey } from './SessionArchiveStore'
import { searchWords } from './sessionSearch'
import { snippetAround } from './sessionText'
import { MemorySessionTextStore, type SessionTextStore } from './SessionTextStore'

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
  /** Where the search words occur in the conversation, when searching. */
  matchText?: string
}

interface ConversationText {
  size: number
  mtimeMs: number
  text: string
  lower: string
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
  private readonly texts = new Map<string, ConversationText>()
  private readonly extracting = new Map<string, Promise<ConversationText | null>>()
  private textsLoaded: Promise<void> | null = null
  /** Bumps on every refresh, so a background pass over an old listing stops. */
  private generation = 0

  constructor(
    private readonly fs: SessionFileSystem,
    /** One reader per agent that keeps sessions. */
    private readonly sources: ReadonlyMap<AiTaskHost, AgentSessionSource>,
    private readonly archive: SessionArchiveStore,
    private readonly textStore: SessionTextStore = new MemorySessionTextStore(),
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
    this.generation += 1
    const paths = new Set(this.files.map((file) => file.path))
    for (const path of Array.from(this.summaries.keys())) {
      if (!paths.has(path)) this.summaries.delete(path)
    }
    await this.loadTexts()
    const gone = Array.from(this.texts.keys()).filter((path) => !paths.has(path))
    for (const path of gone) this.texts.delete(path)
    await this.textStore.remove(gone)
  }

  /**
   * Extracts the conversations of the folder's sessions that are not kept
   * yet (or changed), newest first, in the background. Stops when the list
   * is refreshed again.
   */
  async prepareSearch(folder: string): Promise<void> {
    const generation = this.generation
    for (const file of [...this.files]) {
      if (generation !== this.generation) return
      const summary = await this.summarize(file)
      if (!summary || !isInsideFolder(summary.cwd, folder)) continue
      await this.conversation(file)
      // Let the window paint and the user type between sessions.
      await new Promise((resolve) => window.setTimeout(resolve, 0))
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
      let matchText: string | undefined
      if (words.length > 0) {
        const match = await this.search(file, summary, words)
        if (!match) continue
        matchText = match.snippet
      }
      if (!(await this.exists(summary.cwd))) continue
      items.push({ ...summary, archived, ...(matchText ? { matchText } : {}) })
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

  /**
   * Whether every word is in the session's title or its conversation, and the
   * text around the first word found in the conversation.
   */
  private async search(
    file: AgentSessionFile,
    summary: AgentSessionSummary,
    words: readonly string[],
  ): Promise<{ snippet?: string } | null> {
    const known = [summary.title, summary.firstText ?? '', summary.lastText ?? ''].join('\n').toLowerCase()
    const conversation = await this.conversation(file)
    const lower = conversation?.lower ?? ''
    if (!words.every((word) => known.includes(word) || lower.includes(word))) return null
    if (!conversation) return {}
    for (const word of words) {
      const snippet = snippetAround(conversation.text, conversation.lower, word)
      if (snippet) return { snippet }
    }
    return {}
  }

  /** The session's conversation, extracted once and kept until the file changes. */
  private async conversation(file: AgentSessionFile): Promise<ConversationText | null> {
    await this.loadTexts()
    const kept = this.texts.get(file.path)
    if (kept && kept.size === file.size && kept.mtimeMs === file.mtimeMs) return kept
    const running = this.extracting.get(file.path)
    if (running) return running
    const work = this.extract(file).finally(() => this.extracting.delete(file.path))
    this.extracting.set(file.path, work)
    return work
  }

  private async extract(file: AgentSessionFile): Promise<ConversationText | null> {
    const source = this.sources.get(file.host)
    if (!source?.conversationText) return null
    let text: string | null
    try {
      text = await source.conversationText(this.fs, file)
    } catch {
      text = null
    }
    if (text === null) return null
    const entry = { size: file.size, mtimeMs: file.mtimeMs, text, lower: text.toLowerCase() }
    this.texts.set(file.path, entry)
    await this.textStore.put({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, text }).catch(() => undefined)
    return entry
  }

  private loadTexts(): Promise<void> {
    if (!this.textsLoaded) {
      this.textsLoaded = this.textStore
        .loadAll()
        .then((entries) => {
          for (const entry of entries) {
            if (!this.texts.has(entry.path)) {
              this.texts.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, text: entry.text, lower: entry.text.toLowerCase() })
            }
          }
        })
        .catch(() => undefined)
    }
    return this.textsLoaded
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
