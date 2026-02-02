import { normalizePath, TFile } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogSnapshot, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
import { SnapshotConflictError, SnapshotCorruptedError, LegacySnapshotError } from '../../../types/ExecutionLog'
import { LOG_BACKUP_FOLDER, LEGACY_REVISION } from '../constants'
import { parseTaskLogSnapshot } from '../../../utils/executionLogUtils'

export interface SnapshotWriteOptions {
  existingFile?: TFile | null
  previousRaw?: string | null
  forceBackup?: boolean
}

export class LogSnapshotWriter {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  /**
   * スナップショットのパスを取得
   */
  getSnapshotPath(monthKey: string): string {
    const logBase = this.plugin.pathManager.getLogDataPath()
    return normalizePath(`${logBase}/${monthKey}-tasks.json`)
  }

  /**
   * 競合検出付きスナップショット書き込み
   *
   * @param monthKey 月キー (例: '2026-02')
   * @param snapshot 書き込むスナップショット
   * @param expectedRevision 期待するrevision（読み込み時の値）
   * @param options 書き込みオプション
   * @throws SnapshotConflictError 他のデバイスが先に更新した場合
   * @throws LegacySnapshotError 旧形式スナップショットの場合
   * @throws SnapshotCorruptedError JSONパース失敗の場合
   */
  async writeWithConflictDetection(
    monthKey: string,
    snapshot: TaskLogSnapshot,
    expectedRevision: number,
    options?: SnapshotWriteOptions
  ): Promise<void> {
    const logPath = this.getSnapshotPath(monthKey)

    // LEGACY_REVISION(-1)の場合: 現在のファイルを再読込して判定
    if (expectedRevision === LEGACY_REVISION) {
      const existingFile = this.plugin.app.vault.getAbstractFileByPath(logPath)
      if (existingFile instanceof TFile) {
        let currentContent: string
        try {
          currentContent = await this.plugin.app.vault.read(existingFile)
        } catch {
          // 読み込み失敗は破損扱い
          throw new SnapshotCorruptedError(logPath)
        }

        let parsedSnapshot: TaskLogSnapshot | null = null
        try {
          parsedSnapshot = parseTaskLogSnapshot(currentContent, { throwOnError: true })
        } catch {
          throw new SnapshotCorruptedError(logPath)
        }

        // rawデータでmetaフィールドの有無を判定（parseTaskLogSnapshotはmeta無しでもrevision=0を補完するため）
        let hasMetaInRaw = false
        try {
          const rawParsed = JSON.parse(currentContent) as { meta?: unknown }
          hasMetaInRaw = rawParsed.meta !== undefined && rawParsed.meta !== null
        } catch {
          // parse失敗は破損扱い
        }

        if (hasMetaInRaw) {
          const currentRevision = parsedSnapshot.meta?.revision
          if (typeof currentRevision === 'number' && currentRevision >= 0) {
            // 他のデバイスが既に新形式に移行済み → 通常の競合として扱う
            console.warn(`[LogSnapshotWriter] Legacy expected but current is new format (rev=${currentRevision})`)
            throw new SnapshotConflictError(parsedSnapshot)
          }
        }

        // Legacyの場合はマイグレーション強制
        console.warn('[LogSnapshotWriter] Legacy snapshot detected, forcing migration')
        throw new LegacySnapshotError(logPath, parsedSnapshot)
      }

      // ファイルが存在しない場合もLegacy扱い（新規作成）
      console.warn('[LogSnapshotWriter] No existing file, forcing migration')
      throw new LegacySnapshotError(logPath, snapshot)
    }

    // 通常の競合検出: 書き込み前に現在のファイルを再読込
    const existingFile = this.plugin.app.vault.getAbstractFileByPath(logPath)
    if (existingFile instanceof TFile) {
      let currentContent: string
      try {
        currentContent = await this.plugin.app.vault.read(existingFile)
      } catch (e) {
        console.warn('[LogSnapshotWriter] Failed to read current snapshot for conflict check', e)
        throw new SnapshotCorruptedError(logPath)
      }

      let currentSnapshot: TaskLogSnapshot
      try {
        currentSnapshot = parseTaskLogSnapshot(currentContent, { throwOnError: true })
      } catch {
        console.warn('[LogSnapshotWriter] Corrupted snapshot, rebuilding from delta')
        throw new SnapshotCorruptedError(logPath)
      }

      // revisionが変わっていたら競合検出
      const currentRevision = currentSnapshot.meta?.revision ?? LEGACY_REVISION
      if (currentRevision !== expectedRevision) {
        console.warn(`[LogSnapshotWriter] Conflict: expected=${expectedRevision}, current=${currentRevision}`)
        throw new SnapshotConflictError(currentSnapshot)
      }
    }

    // expectedRevisionを基準に+1
    if (!snapshot.meta) {
      snapshot.meta = { revision: 0, processedCursor: {} }
    }
    snapshot.meta.revision = expectedRevision + 1

    // 既存のwriteメソッドを呼び出し、バックアップ作成とvault.modify経路を維持
    await this.write(monthKey, snapshot, options)
  }

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
      const backupRoot = normalizePath(`${logBase}/${LOG_BACKUP_FOLDER}`)
      await this.plugin.pathManager.ensureFolderExists(backupRoot)
      const monthFolder = normalizePath(`${backupRoot}/${monthKey}`)
      await this.plugin.pathManager.ensureFolderExists(monthFolder)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = normalizePath(`${monthFolder}/${timestamp}.json`)
      const adapter = this.plugin.app.vault.adapter
      if (adapter && typeof adapter.write === 'function') {
        await adapter.write(backupPath, contents)
      }
      // ensure legacy folder is kept for backwards compatibility if it already exists
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
    const hours = this.plugin.settings.backupIntervalHours ?? 2
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
