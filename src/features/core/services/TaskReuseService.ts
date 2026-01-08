import { Notice, TFile } from 'obsidian'
import { t } from '../../../i18n'
import type { TaskChutePluginLike } from '../../../types'
import { TaskIdManager, extractTaskIdFromFrontmatter } from '../../../services/TaskIdManager'

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

    // パスレベルのhiddenRoutinesをクリア（instanceIdがnullまたはundefinedのもの）
    // インスタンス固有のhidden（instanceIdあり）は残す
    dayState.hiddenRoutines = dayState.hiddenRoutines.filter((entry) => {
      if (typeof entry === 'string') {
        return entry !== file.path
      }
      // パスが一致し、instanceIdがない場合はクリア
      if (entry.path === file.path && !entry.instanceId) {
        return false
      }
      return true
    })

    // temporary削除エントリをクリア（同じパスのもの）
    // permanent削除エントリは残す
    dayState.deletedInstances = dayState.deletedInstances.filter((entry) => {
      if (entry.path === file.path && entry.deletionType === 'temporary') {
        return false
      }
      return true
    })

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
