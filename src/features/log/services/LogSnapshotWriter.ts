import { normalizePath, TFile } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogSnapshot, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'

export interface SnapshotWriteOptions {
  existingFile?: TFile | null
  previousRaw?: string | null
  forceBackup?: boolean
}

export class LogSnapshotWriter {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async write(monthKey: string, snapshot: TaskLogSnapshot, options?: SnapshotWriteOptions): Promise<void> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const shouldBackup = this.shouldWriteBackup(snapshot.meta, options?.forceBackup)

    const existingFile =
      options?.existingFile ?? this.plugin.app.vault.getAbstractFileByPath(logPath)
    if (existingFile && existingFile instanceof TFile) {
      const previousRaw =
        options?.previousRaw ?? (await this.safeRead(existingFile)) ?? null
      const willBackup = shouldBackup && !!previousRaw
      if (willBackup) {
        this.markBackupTimestamp(snapshot)
      }
      const payload = JSON.stringify(snapshot, null, 2)
      await this.writeWithBackup(
        existingFile,
        payload,
        monthKey,
        previousRaw,
        shouldBackup,
      )
      return
    }

    const payload = JSON.stringify(snapshot, null, 2)
    await this.plugin.pathManager.ensureFolderExists(logBase)
    await this.plugin.app.vault.create(logPath, payload)
  }

  private async safeRead(file: TFile): Promise<string | null> {
    try {
      return await this.plugin.app.vault.read(file)
    } catch (error) {
      console.warn('[LogSnapshotWriter] Failed to read snapshot before backup', file.path, error)
      return null
    }
  }

  private async writeWithBackup(
    file: TFile,
    payload: string,
    monthKey: string,
    previousRaw: string | null,
    shouldBackup: boolean,
  ): Promise<void> {
    try {
      if (shouldBackup && previousRaw) {
        await this.writeBackup(monthKey, previousRaw)
      }
      await this.plugin.app.vault.modify(file, payload)
    } catch (error) {
      console.warn('[LogSnapshotWriter] Failed to write snapshot', file.path, error)
    }
  }

  private async writeBackup(monthKey: string, contents: string): Promise<void> {
    try {
      const logBase = this.plugin.pathManager.getLogDataPath()
      const backupRoot = normalizePath(`${logBase}/.backups`)
      await this.plugin.pathManager.ensureFolderExists(backupRoot)
      const monthFolder = normalizePath(`${backupRoot}/${monthKey}`)
      await this.plugin.pathManager.ensureFolderExists(monthFolder)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = normalizePath(`${monthFolder}/${timestamp}.json`)
      const adapter = this.plugin.app.vault.adapter
      if (adapter && typeof adapter.write === 'function') {
        await adapter.write(backupPath, contents)
      }
    } catch (error) {
      console.warn('[LogSnapshotWriter] Failed to write backup', error)
    }
  }

  private shouldWriteBackup(meta?: TaskLogSnapshotMeta, force = false): boolean {
    if (force) {
      return true
    }
    const intervalMillis = this.getBackupIntervalMillis()
    if (intervalMillis <= 0) {
      return true
    }
    const lastBackupAt = meta?.lastBackupAt
    if (!lastBackupAt) {
      return true
    }
    const last = Date.parse(lastBackupAt)
    if (Number.isNaN(last)) {
      return true
    }
    return Date.now() - last >= intervalMillis
  }

  private getBackupIntervalMillis(): number {
    const hours = this.plugin.settings.backupIntervalHours ?? 24
    if (!Number.isFinite(hours) || hours <= 0) {
      return 0
    }
    return hours * 60 * 60 * 1000
  }

  private markBackupTimestamp(snapshot: TaskLogSnapshot): void {
    if (!snapshot.meta) {
      snapshot.meta = { revision: 0, processedCursor: {}, lastBackupAt: undefined }
    }
    snapshot.meta.lastBackupAt = new Date().toISOString()
  }
}
