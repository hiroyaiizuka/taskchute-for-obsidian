import { Notice, TFile } from 'obsidian'
import { t } from '../../../i18n'
import type { TaskChutePluginLike } from '../../../types'
import type { DayState } from '../../../types'

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
    const dayState = (await this.plugin.dayStateService.loadDay(date)) as DayState
    if (!Array.isArray(dayState.duplicatedInstances)) {
      dayState.duplicatedInstances = []
    }

    const timestamp = Date.now()
    dayState.duplicatedInstances.push({
      instanceId: this.generateInstanceId(file.basename, dateStr),
      originalPath: file.path,
      slotKey,
      timestamp,
      createdMillis: timestamp,
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
