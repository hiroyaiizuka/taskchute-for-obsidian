import { TFile, TFolder, normalizePath } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogSnapshot, TaskLogEntry, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
import { SnapshotCorruptedError } from '../../../types/ExecutionLog'
import {
  LOG_BACKUP_FOLDER,
  LOG_BACKUP_LEGACY_FOLDER,
  LOG_INBOX_FOLDER,
  LOG_INBOX_LEGACY_FOLDER,
  LOG_HEATMAP_FOLDER,
  LOG_HEATMAP_LEGACY_FOLDER,
} from '../constants'
import { LogSnapshotWriter } from './LogSnapshotWriter'
import { RecordsWriter } from './RecordsWriter'
import { parseCursorSnapshotRevision, parseTaskLogSnapshot } from '../../../utils/executionLogUtils'
import { MonthSyncCoordinator } from './MonthSyncCoordinator'

export interface BackupEntry {
  path: string
  timestamp: Date
  label: string
  monthKey: string
}

export interface TaskExecutionPreview {
  taskName: string
  startTime: string
  endTime: string
}

export interface BackupPreview {
  targetDate: string
  executions: TaskExecutionPreview[]
}

interface QuarantinedDeltaFile {
  originalPath: string
  quarantinePath: string
}

export class BackupRestoreService {
  private readonly snapshotWriter: LogSnapshotWriter

  constructor(private readonly plugin: TaskChutePluginLike) {
    this.snapshotWriter = new LogSnapshotWriter(plugin)
  }

  listBackups(): Map<string, BackupEntry[]> {
    const result = new Map<string, BackupEntry[]>()
    const roots = this.getBackupRoots()

    for (const root of roots) {
      this.collectBackupsFromRoot(root, result)
    }

    // Sort each month's backups by timestamp descending (newest first)
    for (const [monthKey, entries] of result) {
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      result.set(monthKey, entries)
    }

    return result
  }

  async restoreFromBackup(monthKey: string, backupPath: string): Promise<void> {
    await MonthSyncCoordinator.withMonthLock(monthKey, async () => {
      const adapter = this.plugin.app.vault.adapter
      const backupContent = await adapter.read(backupPath)
      const snapshot = this.parseBackupSnapshot(backupContent, backupPath)
      const expectedRevision = await this.resolveExpectedRevision(monthKey, snapshot.meta?.revision ?? 0)
      const quarantineId = this.createRestoreQuarantineId(monthKey)
      const quarantinedDeltaFiles = await this.quarantineDeltaFilesForMonth(monthKey, quarantineId)

      let restoreQuarantinedRequired = true
      try {
        try {
          await this.snapshotWriter.writeWithConflictDetection(monthKey, snapshot, expectedRevision)
        } catch (error) {
          if (error instanceof SnapshotCorruptedError) {
            console.warn('[BackupRestoreService] Corrupted current snapshot detected, forcing restore write', monthKey)
            await this.snapshotWriter.write(monthKey, snapshot)
          } else {
            throw error
          }
        }

        // Clear heatmap cache for the year to ensure UI shows restored data
        const year = monthKey.split('-')[0]
        await this.clearHeatmapCacheForYear(year)

        // Rebuild records for all dates in the restored snapshot
        await this.rebuildRecordsForMonth(snapshot)
        await this.cleanupQuarantinedDeltaFiles(quarantinedDeltaFiles)
        restoreQuarantinedRequired = false
      } finally {
        if (restoreQuarantinedRequired) {
          await this.restoreQuarantinedDeltaFiles(quarantinedDeltaFiles)
        }
      }
    })
  }

  /**
   * Get the latest date that has execution records in a backup
   * Used to show meaningful preview when opening restore modal
   */
  async getLatestDateInBackup(backupPath: string): Promise<string | undefined> {
    try {
      const adapter = this.plugin.app.vault.adapter
      const content = await adapter.read(backupPath)
      const parsed: unknown = JSON.parse(content)
      const snapshot = parsed as TaskLogSnapshot

      const dates = Object.keys(snapshot.taskExecutions ?? {})
        .filter(d => {
          const entries = snapshot.taskExecutions?.[d]
          return Array.isArray(entries) && entries.length > 0
        })
        .sort()
        .reverse()

      return dates[0] // Return the most recent date with data
    } catch (error) {
      console.warn('[BackupRestoreService] Failed to get latest date from backup', backupPath, error)
      return undefined
    }
  }

  private async rebuildRecordsForMonth(snapshot: TaskLogSnapshot): Promise<void> {
    const recordsWriter = new RecordsWriter(this.plugin)
    const taskExecutions = snapshot.taskExecutions ?? {}
    const dailySummary = snapshot.dailySummary ?? {}

    // Collect all unique dates from both taskExecutions and dailySummary
    // (summary-only dates should also have records regenerated)
    const allDates = new Set([
      ...Object.keys(taskExecutions),
      ...Object.keys(dailySummary),
    ])

    for (const dateKey of allDates) {
      const entries = Array.isArray(taskExecutions[dateKey]) ? taskExecutions[dateKey] : []
      const summary = dailySummary[dateKey]

      try {
        await recordsWriter.writeDay({
          dateKey,
          entries,
          summary,
          canonicalRevision: snapshot.meta?.revision ?? 0,
          snapshotMeta: snapshot.meta,
        })
      } catch (error) {
        console.warn('[BackupRestoreService] Failed to rebuild record for date', dateKey, error)
      }
    }
  }

  private parseBackupSnapshot(raw: string, backupPath: string): TaskLogSnapshot {
    try {
      const parsed = JSON.parse(raw) as Partial<TaskLogSnapshot>
      const meta: TaskLogSnapshotMeta = {
        revision: typeof parsed.meta?.revision === 'number' ? parsed.meta.revision : 0,
        lastProcessedAt: typeof parsed.meta?.lastProcessedAt === 'string' ? parsed.meta.lastProcessedAt : undefined,
        processedCursor: parsed.meta?.processedCursor && typeof parsed.meta.processedCursor === 'object'
          ? { ...parsed.meta.processedCursor }
          : {},
        cursorSnapshotRevision: parseCursorSnapshotRevision(parsed.meta?.cursorSnapshotRevision),
        lastBackupAt: typeof parsed.meta?.lastBackupAt === 'string' ? parsed.meta.lastBackupAt : undefined,
      }

      return {
        ...parsed,
        taskExecutions: this.normalizeTaskExecutions(parsed.taskExecutions),
        dailySummary: this.normalizeDailySummary(parsed.dailySummary),
        meta,
      }
    } catch (error) {
      console.warn('[BackupRestoreService] Failed to parse backup snapshot', backupPath, error)
      throw error
    }
  }

  private async resolveExpectedRevision(monthKey: string, fallbackRevision: number): Promise<number> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const file = this.plugin.app.vault.getAbstractFileByPath(logPath)
    if (!(file instanceof TFile)) {
      return Math.max(0, fallbackRevision - 1)
    }

    try {
      const raw = await this.plugin.app.vault.read(file)
      const current = parseTaskLogSnapshot(raw, { throwOnError: true })
      const revision = current.meta?.revision
      return typeof revision === 'number' ? revision : 0
    } catch (error) {
      console.warn('[BackupRestoreService] Failed to read current revision, using fallback revision', monthKey, error)
      return Math.max(0, fallbackRevision - 1)
    }
  }

  private async quarantineDeltaFilesForMonth(monthKey: string, quarantineId: string): Promise<QuarantinedDeltaFile[]> {
    const quarantined: QuarantinedDeltaFile[] = []
    const base = this.plugin.pathManager.getLogDataPath()
    const inboxPaths = [
      normalizePath(`${base}/${LOG_INBOX_FOLDER}`),
      normalizePath(`${base}/${LOG_INBOX_LEGACY_FOLDER}`),
    ]

    for (const inboxPath of inboxPaths) {
      await this.quarantineDeltaFilesInInbox(inboxPath, monthKey, quarantineId, quarantined)
    }

    return quarantined
  }

  private async quarantineDeltaFilesInInbox(
    inboxPath: string,
    monthKey: string,
    quarantineId: string,
    quarantined: QuarantinedDeltaFile[],
  ): Promise<void> {
    const root = this.plugin.app.vault.getAbstractFileByPath(inboxPath)
    if (!root || !(root instanceof TFolder)) {
      return
    }

    const targetFileNames = new Set([
      `${monthKey}.jsonl`,
      `${monthKey}.archived.jsonl`,
    ])

    for (const deviceFolder of root.children) {
      if (!(deviceFolder instanceof TFolder)) continue

      for (const file of deviceFolder.children) {
        if (!(file instanceof TFile)) continue
        if (!targetFileNames.has(file.name)) continue

        try {
          const content = await this.readFileContent(file.path)
          if (content === null) {
            continue
          }
          const quarantinePath = this.buildQuarantinePath(quarantineId, file.path)
          await this.ensureParentFolderExists(quarantinePath)
          await this.writeFileContent(quarantinePath, content)
          quarantined.push({ originalPath: file.path, quarantinePath })

          // Reconcile側から見えないように元deltaはinboxから除去する
          await this.plugin.app.fileManager.trashFile(file)
        } catch (error) {
          console.warn('[BackupRestoreService] Failed to quarantine delta file', file.path, error)
        }
      }
    }
  }

  private async restoreQuarantinedDeltaFiles(files: QuarantinedDeltaFile[]): Promise<void> {
    for (const file of files) {
      let restoredToOriginal = false
      try {
        const quarantinedContent = await this.readFileContent(file.quarantinePath)
        if (quarantinedContent === null) {
          continue
        }

        const existingOriginal = this.plugin.app.vault.getAbstractFileByPath(file.originalPath)
        const currentContent = existingOriginal instanceof TFile
          ? await this.readFileContent(file.originalPath)
          : null
        const mergedContent = this.mergeRollbackDeltaContent(quarantinedContent, currentContent)

        await this.ensureParentFolderExists(file.originalPath)
        await this.writeFileContent(file.originalPath, mergedContent)
        restoredToOriginal = true
      } catch (error) {
        console.warn('[BackupRestoreService] Failed to restore quarantined delta file', file, error)
      }

      if (!restoredToOriginal) {
        continue
      }

      const quarantinedFile = this.plugin.app.vault.getAbstractFileByPath(file.quarantinePath)
      if (quarantinedFile && quarantinedFile instanceof TFile) {
        try {
          await this.plugin.app.fileManager.trashFile(quarantinedFile)
        } catch (error) {
          console.warn('[BackupRestoreService] Failed to cleanup quarantined delta file', file.quarantinePath, error)
        }
      }
    }
  }

  private mergeRollbackDeltaContent(quarantinedContent: string, currentContent: string | null): string {
    if (!currentContent || currentContent.length === 0) {
      return quarantinedContent
    }
    if (quarantinedContent.length === 0) {
      return currentContent
    }
    if (currentContent === quarantinedContent) {
      return currentContent
    }
    // If another writer appended after quarantine, keep the longer observed stream.
    if (currentContent.startsWith(quarantinedContent)) {
      return currentContent
    }
    if (quarantinedContent.startsWith(currentContent)) {
      return quarantinedContent
    }

    const needsSeparator = !quarantinedContent.endsWith('\n') && !currentContent.startsWith('\n')
    return `${quarantinedContent}${needsSeparator ? '\n' : ''}${currentContent}`
  }

  private async cleanupQuarantinedDeltaFiles(files: QuarantinedDeltaFile[]): Promise<void> {
    for (const file of files) {
      const quarantinedFile = this.plugin.app.vault.getAbstractFileByPath(file.quarantinePath)
      if (!quarantinedFile || !(quarantinedFile instanceof TFile)) {
        continue
      }
      try {
        await this.plugin.app.fileManager.trashFile(quarantinedFile)
      } catch (error) {
        console.warn('[BackupRestoreService] Failed to cleanup quarantined delta file after restore', file.quarantinePath, error)
      }
    }
  }

  private createRestoreQuarantineId(monthKey: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    return `${monthKey}-${timestamp}`
  }

  private buildQuarantinePath(quarantineId: string, originalPath: string): string {
    const base = normalizePath(this.plugin.pathManager.getLogDataPath())
    const normalizedOriginal = normalizePath(originalPath)
    const relative = normalizedOriginal.startsWith(`${base}/`)
      ? normalizedOriginal.slice(base.length + 1)
      : normalizedOriginal.replace(/[\\/]/g, '_')
    return normalizePath(`${base}/.restore-quarantine/${quarantineId}/${relative}`)
  }

  private async ensureParentFolderExists(path: string): Promise<void> {
    const normalized = normalizePath(path)
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash <= 0) {
      return
    }
    const parentPath = normalized.slice(0, lastSlash)
    await this.plugin.pathManager.ensureFolderExists(parentPath)
  }

  private async readFileContent(path: string): Promise<string | null> {
    const adapter = this.plugin.app.vault.adapter as { read?: (path: string) => Promise<string> }
    if (!adapter || typeof adapter.read !== 'function') {
      return null
    }
    try {
      return await adapter.read(path)
    } catch (error) {
      console.warn('[BackupRestoreService] Failed to read file content', path, error)
      return null
    }
  }

  private normalizeTaskExecutions(input: unknown): Record<string, TaskLogEntry[]> {
    if (!input || typeof input !== 'object') {
      return {}
    }
    const normalized: Record<string, TaskLogEntry[]> = {}
    for (const [dateKey, entries] of Object.entries(input as Record<string, unknown>)) {
      if (Array.isArray(entries)) {
        normalized[dateKey] = entries.filter((entry): entry is TaskLogEntry => !!entry && typeof entry === 'object')
        continue
      }
      if (!entries || typeof entries !== 'object') {
        normalized[dateKey] = []
        continue
      }

      const asRecord = entries as Record<string, unknown>
      const knownEntryKeys = [
        'instanceId',
        'taskId',
        'taskTitle',
        'taskName',
        'taskPath',
        'startTime',
        'stopTime',
        'durationSec',
        'duration',
        'entryId',
        'deviceId',
        'recordedAt',
      ]
      const hasKnownEntryKey = knownEntryKeys.some((key) => key in asRecord)
      if (hasKnownEntryKey) {
        normalized[dateKey] = [asRecord as TaskLogEntry]
        continue
      }

      const nestedEntries = Object.values(asRecord)
        .filter((value): value is TaskLogEntry => !!value && typeof value === 'object')
      normalized[dateKey] = nestedEntries
      if (normalized[dateKey].length === 0) {
        normalized[dateKey] = []
      }
    }
    return normalized
  }

  private normalizeDailySummary(input: unknown): Record<string, TaskLogSnapshot['dailySummary'][string]> {
    if (!input || typeof input !== 'object') {
      return {}
    }
    const normalized: Record<string, TaskLogSnapshot['dailySummary'][string]> = {}
    for (const [dateKey, summary] of Object.entries(input as Record<string, unknown>)) {
      if (summary && typeof summary === 'object') {
        normalized[dateKey] = summary as TaskLogSnapshot['dailySummary'][string]
      }
    }
    return normalized
  }

  private async writeFileContent(path: string, content: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter as { write?: (path: string, data: string) => Promise<void> }
    if (!adapter || typeof adapter.write !== 'function') {
      return
    }
    await adapter.write(path, content)
  }

  private async clearHeatmapCacheForYear(year: string): Promise<void> {
    const base = this.plugin.pathManager.getLogDataPath()

    // All possible locations of yearly heatmap cache
    const cachePaths = [
      normalizePath(`${base}/${LOG_HEATMAP_FOLDER}/${year}/yearly-heatmap.json`),
      normalizePath(`${base}/${LOG_HEATMAP_LEGACY_FOLDER}/${year}/yearly-heatmap.json`),
    ]

    for (const cachePath of cachePaths) {
      const file = this.plugin.app.vault.getAbstractFileByPath(cachePath)
      if (file && file instanceof TFile) {
        try {
          await this.plugin.app.fileManager.trashFile(file)
        } catch (error) {
          console.warn('[BackupRestoreService] Failed to delete heatmap cache', cachePath, error)
        }
      }
    }
  }

  async getBackupPreview(backupPath: string, targetDate?: string): Promise<BackupPreview> {
    const adapter = this.plugin.app.vault.adapter
    const content = await adapter.read(backupPath)
    const parsed: unknown = JSON.parse(content)
    const snapshot = parsed as TaskLogSnapshot

    // Use today's date if not specified
    const dateKey = targetDate ?? this.formatDateKey(new Date())

    const executionsRecord: Record<string, TaskLogEntry[]> = snapshot.taskExecutions ?? {}
    const entries: TaskLogEntry[] = executionsRecord[dateKey] ?? []

    // Sort by start time
    const sortedEntries = [...entries].sort((a, b) => {
      const aTime = a.startTime ?? ''
      const bTime = b.startTime ?? ''
      return aTime.localeCompare(bTime)
    })

    // Build executions list with time info
    const executions: TaskExecutionPreview[] = sortedEntries.map((entry) => ({
      taskName: entry.taskTitle ?? entry.taskName ?? '(不明)',
      startTime: entry.startTime ?? '-',
      endTime: entry.stopTime ?? '-',
    }))

    return {
      targetDate: dateKey,
      executions,
    }
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  formatRelativeTime(date: Date, now: Date = new Date()): string {
    const diffMs = now.getTime() - date.getTime()
    const diffMinutes = Math.floor(diffMs / (60 * 1000))
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000))
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000))

    if (diffMinutes < 60) {
      return `${diffMinutes}分前`
    } else if (diffHours < 24) {
      return `${diffHours}時間前`
    } else {
      return `${diffDays}日前`
    }
  }

  private getBackupRoots(): TFolder[] {
    const roots: TFolder[] = []
    const base = this.plugin.pathManager.getLogDataPath()
    const paths = new Set<string>([
      normalizePath(`${base}/${LOG_BACKUP_FOLDER}`),
      normalizePath(`${base}/${LOG_BACKUP_LEGACY_FOLDER}`),
    ])

    for (const path of paths) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path)
      if (file && file instanceof TFolder) {
        roots.push(file)
      }
    }

    return roots
  }

  private collectBackupsFromRoot(
    root: TFolder,
    result: Map<string, BackupEntry[]>
  ): void {
    const now = new Date()

    for (const child of root.children) {
      if (!(child instanceof TFolder)) continue

      const monthKey = child.name
      if (!this.isValidMonthKey(monthKey)) continue

      const entries: BackupEntry[] = []

      for (const file of child.children) {
        if (!(file instanceof TFile)) continue
        if (file.extension !== 'json') continue

        const timestamp = this.parseTimestampFromFilename(file.basename)
        if (!timestamp) continue

        entries.push({
          path: file.path,
          timestamp,
          label: this.formatRelativeTime(timestamp, now),
          monthKey,
        })
      }

      if (entries.length > 0) {
        const existing = result.get(monthKey) ?? []
        result.set(monthKey, [...existing, ...entries])
      }
    }
  }

  private isValidMonthKey(name: string): boolean {
    return /^\d{4}-\d{2}$/.test(name)
  }

  private parseTimestampFromFilename(basename: string): Date | null {
    // Filename format: 2025-12-08T14-30-00-000Z
    // Need to convert back to ISO format: 2025-12-08T14:30:00.000Z
    try {
      // Replace hyphens back to colons and dots in the time portion
      const isoString = basename
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z')

      const date = new Date(isoString)
      if (isNaN(date.getTime())) return null
      return date
    } catch {
      return null
    }
  }
}
