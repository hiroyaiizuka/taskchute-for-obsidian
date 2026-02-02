import { Notice, TFile } from 'obsidian'
import { t } from '../../../i18n'
import type { TaskChutePluginLike } from '../../../types'
import { TaskIdManager, extractTaskIdFromFrontmatter } from '../../../services/TaskIdManager'
import { getEffectiveDeletedAt } from '../../../services/dayState/conflictResolver'

export class TaskReuseService {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async reuseTaskAtDate(path: string, dateStr: string, slotKey: string = 'none'): Promise<TFile> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      throw new Error(
        t('addTask.reuseFileMissing', 'Task file not found: {path}', { path }),
      )
    }

    await this.recordDuplicateForDate(file, dateStr, slotKey)

    new Notice(
      t('addTask.reuseSuccess', 'Reused "{name}" for {date}', {
        name: file.basename,
        date: dateStr,
      }),
    )

    return file
  }

  private async recordDuplicateForDate(file: TFile, dateStr: string, slotKey: string): Promise<void> {
    const date = this.plugin.dayStateService.getDateFromKey(dateStr)
    const dayState = (await this.plugin.dayStateService.loadDay(date))
    if (!Array.isArray(dayState.duplicatedInstances)) {
      dayState.duplicatedInstances = []
    }
    if (!Array.isArray(dayState.hiddenRoutines)) {
      dayState.hiddenRoutines = []
    }
    if (!Array.isArray(dayState.deletedInstances)) {
      dayState.deletedInstances = []
    }

    // パスレベルのhiddenRoutinesは復元済みとして記録（同期のため tombstone を残す）
    // インスタンス固有のhidden（instanceIdあり）は残す
    const now = Date.now()
    const coerceRestoredAt = (prevRestoredAt: number | undefined, baseTime: number | undefined): number => {
      const prev = prevRestoredAt ?? 0
      const base = baseTime ?? 0
      const minRestoredAt = base > 0 ? base + 1 : now
      return Math.max(prev, now, minRestoredAt)
    }
    dayState.hiddenRoutines = dayState.hiddenRoutines
      .map((entry) => {
        if (!entry) return entry
        if (typeof entry === 'string') {
          if (entry === file.path) {
            return { path: entry, instanceId: null, restoredAt: coerceRestoredAt(undefined, 0) }
          }
          return entry
        }
        if (entry.path === file.path && !entry.instanceId) {
          return { ...entry, restoredAt: coerceRestoredAt(entry.restoredAt, entry.hiddenAt) }
        }
        return entry
      })
      .filter(Boolean)

    // temporary削除は復元 tombstone として残す（同期で復元を伝播するため）
    dayState.deletedInstances = dayState.deletedInstances
      .map((entry) => {
        if (!entry) return entry
        if (entry.path === file.path && entry.deletionType === 'temporary') {
          const deletedAt = getEffectiveDeletedAt(entry)
          return { ...entry, restoredAt: coerceRestoredAt(entry.restoredAt, deletedAt) }
        }
        return entry
      })
      .filter(Boolean)

    const timestamp = Date.now()
    const metadata = this.plugin.app.metadataCache.getFileCache(file)
    let taskId = extractTaskIdFromFrontmatter(metadata?.frontmatter as Record<string, unknown> | undefined)
    if (!taskId) {
      try {
        const manager = new TaskIdManager(this.plugin)
        taskId = (await manager.ensureTaskIdForFile(file)) ?? undefined
      } catch (error) {
        this.plugin._log?.('warn', '[TaskReuseService] Failed to ensure taskId for duplicate', error)
      }
    }
    dayState.duplicatedInstances.push({
      instanceId: this.generateInstanceId(file.basename, dateStr),
      originalPath: file.path,
      slotKey,
      timestamp,
      createdMillis: timestamp,
      originalTaskId: taskId,
    })

    await this.plugin.dayStateService.saveDay(date, dayState)
  }

  private generateInstanceId(seed: string, dateStr: string): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID()
    }
    const random = Math.random().toString(36).slice(2, 10)
    return `reuse-${seed}-${dateStr}-${random}`
  }
}
