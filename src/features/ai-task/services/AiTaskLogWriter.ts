/**
 * AI Task - run log writer
 *
 * Persists one markdown note per finished AI run under
 * `<base>/TaskChute/AI/Logs/YYYY-MM/YYYYMMDD-HHmmss-<sanitized name>.md`,
 * and prunes notes older than the retention window. Folders are created
 * lazily on the first write (never in ensureRequiredFolders), the note is
 * written with a single vault.create at run end, and pruning always goes
 * through fileManager.trashFile (never vault.delete).
 */

import { TFile } from 'obsidian'
import { listFilesInFolder } from '../../../utils/vaultFiles'
import type { AiResultEvent, AiRunRecord, AiStreamEvent } from '../types'

/** Maximum stderr lines preserved at the end of a run log note */
export const STDERR_TAIL_LIMIT = 50

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_NAME_LENGTH = 60

export interface AiTaskLogWriterDeps {
  app: {
    vault: {
      create(path: string, content: string): Promise<unknown>
      modify(file: TFile, content: string): Promise<unknown>
      getAbstractFileByPath(path: string): unknown
      getRoot?(): unknown
    }
    fileManager: {
      trashFile(file: TFile): Promise<void>
    }
  }
  pathManager: {
    getAiLogsPath(): string
    getAiLogsMonthPath(yearMonth: string): string
    ensureFolderExists(path: string): Promise<void>
  }
  /** Retention window in days; values <= 0 disable pruning */
  getRetentionDays(): number
  /** Clock override for tests */
  now?(): number
  log?(level: 'warn' | 'error' | 'debug', ...args: unknown[]): void
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function formatYearMonth(epochMs: number): string {
  const date = new Date(epochMs)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}`
}

function formatFileTimestamp(epochMs: number): string {
  const date = new Date(epochMs)
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`
  const hms = `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`
  return `${ymd}-${hms}`
}

/** Replace vault-hostile characters and whitespace with single dashes */
function sanitizeTaskName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\p{C}/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
  return cleaned.length > 0 ? cleaned : 'task'
}

function findLastResultEvent(events: AiStreamEvent[]): AiResultEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.kind === 'result') return event
  }
  return undefined
}

function composeFrontmatter(record: AiRunRecord): string[] {
  const lines: string[] = ['---']
  lines.push(`task_path: ${JSON.stringify(record.taskPath)}`)
  lines.push(`task_name: ${JSON.stringify(record.taskName)}`)
  lines.push(`host: ${record.host}`)
  lines.push(`status: ${record.status}`)
  lines.push(`started_at: ${JSON.stringify(new Date(record.startedAt).toISOString())}`)
  if (record.endedAt !== undefined) {
    lines.push(`ended_at: ${JSON.stringify(new Date(record.endedAt).toISOString())}`)
  }
  if (typeof record.exitCode === 'number') {
    lines.push(`exit_code: ${record.exitCode}`)
  }
  const result = findLastResultEvent(record.events)
  if (result?.totalCostUsd !== undefined) {
    lines.push(`cost_usd: ${result.totalCostUsd}`)
  }
  if (result?.numTurns !== undefined) {
    lines.push(`num_turns: ${result.numTurns}`)
  }
  if (record.errorMessage !== undefined && record.errorMessage.length > 0) {
    lines.push(`error: ${JSON.stringify(record.errorMessage)}`)
  }
  lines.push('---')
  return lines
}

function composeInitLine(event: Extract<AiStreamEvent, { kind: 'init' }>): string {
  const parts = ['- [init]']
  if (event.model !== undefined) parts.push(`model ${event.model}`)
  if (event.sessionId !== undefined) parts.push(`session ${event.sessionId}`)
  return parts.join(' ')
}

function composeResultLine(event: AiResultEvent): string {
  const label = event.subtype ?? (event.isError ? 'error' : 'success')
  const details: string[] = []
  if (event.totalCostUsd !== undefined) details.push(`cost $${event.totalCostUsd}`)
  if (event.numTurns !== undefined) details.push(`${event.numTurns} turns`)
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : ''
  return `- [result] ${label}${suffix}`
}

function composeTranscript(events: AiStreamEvent[]): string[] {
  const lines: string[] = ['## Transcript', '']
  for (const event of events) {
    switch (event.kind) {
      case 'assistant-text':
        lines.push(event.text, '')
        break
      case 'tool-use':
        lines.push(`- [tool] ${event.toolName}`)
        break
      case 'tool-result':
        lines.push(`- [tool result]${event.isError === true ? ' (error)' : ''}`)
        break
      case 'user-text':
        lines.push(`> user: ${event.text}`, '')
        break
      case 'init':
        lines.push(composeInitLine(event))
        break
      case 'result':
        lines.push(composeResultLine(event))
        break
      case 'elision':
        lines.push(`- [${event.omittedCount} events omitted]`)
        break
      case 'raw':
        lines.push(`- [raw] ${event.text}`)
        break
      case 'stderr':
        // Rendered separately in the stderr tail section
        break
    }
  }
  return lines
}

function composeStderrSection(events: AiStreamEvent[]): string[] {
  const stderrLines: string[] = []
  for (const event of events) {
    if (event.kind === 'stderr') stderrLines.push(event.text)
  }
  if (stderrLines.length === 0) return []

  const tail = stderrLines.slice(-STDERR_TAIL_LIMIT)
  const lines: string[] = ['', '## Stderr', '']
  if (stderrLines.length > tail.length) {
    lines.push(`Showing the last ${tail.length} of ${stderrLines.length} lines.`, '')
  }
  lines.push('```text', ...tail, '```')
  return lines
}

function composeRunLogContent(record: AiRunRecord): string {
  const lines = [
    ...composeFrontmatter(record),
    '',
    ...composeTranscript(record.events),
    ...composeStderrSection(record.events),
  ]
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function statTimeOf(file: TFile): number | null {
  const stat = (file as { stat?: { mtime?: unknown; ctime?: unknown } }).stat
  if (typeof stat?.mtime === 'number') return stat.mtime
  if (typeof stat?.ctime === 'number') return stat.ctime
  return null
}

export class AiTaskLogWriter {
  constructor(private readonly deps: AiTaskLogWriterDeps) {}

  /**
   * Rewrite the run's existing log note in place, or create it when the run
   * has none yet (or the recorded note has been deleted). Follow-ups call
   * this at every run end so one note carries the whole conversation.
   * Returns the vault path of the note.
   */
  async upsertRunLog(record: AiRunRecord): Promise<string> {
    const existingPath = record.logNotePath
    if (existingPath !== undefined && existingPath.length > 0) {
      const existing = this.deps.app.vault.getAbstractFileByPath(existingPath)
      if (existing instanceof TFile) {
        await this.deps.app.vault.modify(existing, composeRunLogContent(record))
        return existingPath
      }
    }
    return this.writeRunLog(record)
  }

  /**
   * Compose and create the run log note. Called once per run, at run end.
   * Returns the vault path of the created note.
   */
  async writeRunLog(record: AiRunRecord): Promise<string> {
    const monthPath = this.deps.pathManager.getAiLogsMonthPath(
      formatYearMonth(record.startedAt),
    )
    await this.ensureLogFolders(monthPath)

    const baseName = `${formatFileTimestamp(record.startedAt)}-${sanitizeTaskName(record.taskName)}`
    const path = this.resolveCollisionFreePath(monthPath, baseName)
    await this.deps.app.vault.create(path, composeRunLogContent(record))
    return path
  }

  /** Trash run log notes older than the retention window (never vault.delete) */
  async pruneOldLogs(): Promise<void> {
    const retentionDays = this.deps.getRetentionDays()
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return

    const now = this.deps.now?.() ?? Date.now()
    const cutoff = now - retentionDays * DAY_MS
    const files = listFilesInFolder(this.deps.app, this.deps.pathManager.getAiLogsPath(), {
      markdownOnly: true,
      recursive: true,
    })

    for (const file of files) {
      const statTime = statTimeOf(file)
      if (statTime === null || statTime >= cutoff) continue
      try {
        await this.deps.app.fileManager.trashFile(file)
      } catch (error) {
        this.deps.log?.('warn', '[AiTaskLogWriter] Failed to trash old run log', file.path, error)
      }
    }
  }

  /** Lazily create AI, AI/Logs, and the month folder (in that order) */
  private async ensureLogFolders(monthPath: string): Promise<void> {
    const logsPath = this.deps.pathManager.getAiLogsPath()
    const aiParentPath = logsPath.split('/').slice(0, -1).join('/')
    if (aiParentPath.length > 0) {
      await this.deps.pathManager.ensureFolderExists(aiParentPath)
    }
    await this.deps.pathManager.ensureFolderExists(logsPath)
    await this.deps.pathManager.ensureFolderExists(monthPath)
  }

  private resolveCollisionFreePath(monthPath: string, baseName: string): string {
    const basePath = `${monthPath}/${baseName}.md`
    if (!this.deps.app.vault.getAbstractFileByPath(basePath)) return basePath
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${monthPath}/${baseName}-${suffix}.md`
      if (!this.deps.app.vault.getAbstractFileByPath(candidate)) return candidate
    }
  }
}
