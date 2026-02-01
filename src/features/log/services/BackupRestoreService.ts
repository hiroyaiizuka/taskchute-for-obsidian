import { TFile, TFolder, normalizePath } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogSnapshot, TaskLogEntry, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
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
    const adapter = this.plugin.app.vault.adapter
    const backupContent = await adapter.read(backupPath)
    const snapshot = this.parseBackupSnapshot(backupContent, backupPath)

    // Clear delta files for this month to prevent re-sync overwriting the restored data
    await this.clearDeltaFilesForMonth(monthKey)

    // Clear heatmap cache for the year to ensure UI shows restored data
    const year = monthKey.split('-')[0]
    await this.clearHeatmapCacheForYear(year)

    await this.snapshotWriter.write(monthKey, snapshot)

    // Rebuild records for all dates in the restored snapshot
    await this.rebuildRecordsForMonth(snapshot)
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
      const entries = taskExecutions[dateKey] ?? []
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
        lastBackupAt: typeof parsed.meta?.lastBackupAt === 'string' ? parsed.meta.lastBackupAt : undefined,
      }

      return {
        ...parsed,
        taskExecutions: parsed.taskExecutions ?? {},
        dailySummary: parsed.dailySummary ?? {},
        meta,
      }
    } catch (error) {
      console.warn('[BackupRestoreService] Failed to parse backup snapshot', backupPath, error)
      throw error
    }
  }

  private async clearDeltaFilesForMonth(monthKey: string): Promise<void> {
    const base = this.plugin.pathManager.getLogDataPath()
    const inboxPaths = [
      normalizePath(`${base}/${LOG_INBOX_FOLDER}`),
      normalizePath(`${base}/${LOG_INBOX_LEGACY_FOLDER}`),
    ]

    for (const inboxPath of inboxPaths) {
      await this.clearDeltaFilesInInbox(inboxPath, monthKey)
    }
  }

  private async clearDeltaFilesInInbox(inboxPath: string, monthKey: string): Promise<void> {
    const root = this.plugin.app.vault.getAbstractFileByPath(inboxPath)
    if (!root || !(root instanceof TFolder)) {
      return
    }

    const deltaFileName = `${monthKey}.jsonl`

    for (const deviceFolder of root.children) {
      if (!(deviceFolder instanceof TFolder)) continue

      for (const file of deviceFolder.children) {
        if (!(file instanceof TFile)) continue
        if (file.name !== deltaFileName) continue

        try {
          // Use trash instead of delete to respect user preferences
          await this.plugin.app.fileManager.trashFile(file)
        } catch (error) {
          console.warn('[BackupRestoreService] Failed to delete delta file', file.path, error)
        }
      }
    }
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
