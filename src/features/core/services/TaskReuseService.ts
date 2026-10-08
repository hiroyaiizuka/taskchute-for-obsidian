import { Notice, TFile } from 'obsidian'
import { t } from '@/i18n'
import type { TaskChutePluginLike } from '@/types'
import { TaskIdManager, extractTaskIdFromFrontmatter } from '@/services/TaskIdManager'
import { getEffectiveDeletedAt, isHidden } from '@/services/dayState/conflictResolver'
import { baseInstanceId } from './TaskLoaderService'
import { getScheduledTime } from '@/utils/fieldMigration'
import { SectionConfigService } from '@/services/SectionConfigService'

export interface ReuseTaskAtDateOptions {
  slotKey?: string
  scheduledTime?: string
  reminderTime?: string | null
}

export interface ReuseTaskAtDateResult {
  file: TFile
  instanceId: string
}

export class TaskReuseService {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async reuseTaskAtDate(
    path: string,
    dateStr: string,
    options?: string | ReuseTaskAtDateOptions,
  ): Promise<ReuseTaskAtDateResult> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      throw new Error(
        t('taskChuteView.addTask.reuseFileMissing', 'Task file not found: {path}', { path }),
      )
    }

    const normalizedOptions = typeof options === 'string'
      ? { slotKey: options }
      : options
    const instanceId = await this.recordDuplicateForDate(file, dateStr, normalizedOptions)

    new Notice(
      t('taskChuteView.addTask.reuseSuccess', 'Reused "{name}" for {date}', {
        name: file.basename,
        date: dateStr,
      }),
    )

    return { file, instanceId }
  }

  private async recordDuplicateForDate(
    file: TFile,
    dateStr: string,
    options?: ReuseTaskAtDateOptions,
  ): Promise<string> {
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

    // The task's own instance was taken off this day (a routine deleted for
    // today, or moved away): bringing it back is enough, without a duplicate
    // beside it. Read before the entries below are marked restored.
    const ownInstanceWasHidden = dayState.hiddenRoutines.some((entry) => {
      if (!entry) return false
      if (typeof entry === 'string') return entry === file.path
      return entry.path === file.path && !entry.instanceId && isHidden(entry)
    })

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

    if (ownInstanceWasHidden) {
      await this.plugin.dayStateService.saveDay(date, dayState)
      return baseInstanceId(file.path, dateStr)
    }

    const timestamp = Date.now()
    const metadata = this.plugin.app.metadataCache.getFileCache(file)
    const frontmatter = metadata?.frontmatter
    const scheduledTime = options?.scheduledTime
      ?? getScheduledTime(frontmatter)
    const resolvedSlotKey = this.resolveSlotKey(options?.slotKey, scheduledTime)
    let taskId = extractTaskIdFromFrontmatter(metadata?.frontmatter)
    if (!taskId) {
      try {
        const manager = new TaskIdManager(this.plugin)
        taskId = (await manager.ensureTaskIdForFile(file)) ?? undefined
      } catch (error) {
        this.plugin._log?.('warn', '[TaskReuseService] Failed to ensure taskId for duplicate', error)
      }
    }
    const instanceId = this.generateInstanceId(file.basename, dateStr)
    dayState.duplicatedInstances.push({
      ...(options?.scheduledTime ? { scheduledTime: options.scheduledTime } : {}),
      ...(options && options.reminderTime !== undefined ? { reminderTime: options.reminderTime } : {}),
      instanceId,
      originalPath: file.path,
      slotKey: resolvedSlotKey,
      timestamp,
      createdMillis: timestamp,
      originalTaskId: taskId,
    })

    await this.plugin.dayStateService.saveDay(date, dayState)
    return instanceId
  }

  private generateInstanceId(seed: string, dateStr: string): string {
    const cryptoApi = activeWindow.crypto as Crypto | undefined
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID()
    }
    const random = Math.random().toString(36).slice(2, 10)
    return `reuse-${seed}-${dateStr}-${random}`
  }

  private resolveSlotKey(slotKey: string | undefined, scheduledTime: string | undefined): string {
    if (typeof slotKey === 'string' && slotKey.trim().length > 0) {
      return slotKey
    }
    if (!scheduledTime) {
      return 'none'
    }
    const sectionConfig = new SectionConfigService(this.plugin.settings.customSections)
    return sectionConfig.calculateSlotKeyFromTime(scheduledTime) ?? 'none'
  }
}
