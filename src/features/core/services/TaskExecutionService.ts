import { Notice, App, TFile } from 'obsidian'
import { getCurrentTimeSlot } from '../../../utils/time'
import { HeatmapService } from '../../log/services/HeatmapService'
import type { TaskInstance } from '../../../types'
import type { TaskChutePluginLike } from '../../../types'

export interface TaskExecutionHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: App
  plugin: TaskChutePluginLike
  getViewDate(): Date
  getCurrentDateString(): string
  getInstanceDisplayTitle(inst: TaskInstance): string
  renderTaskList(): void
  startGlobalTimer(): void
  restartTimerService(): void
  stopTimers(): void
  saveRunningTasksState(): Promise<void>
  sortTaskInstancesByTimeOrder(): void
  saveTaskOrders(): Promise<void>
  executionLogService: {
    saveTaskLog: (inst: TaskInstance, durationSec: number) => Promise<void>
  }
  setCurrentInstance(inst: TaskInstance | null): void
  getCurrentInstance(): TaskInstance | null
  hasRunningInstances(): boolean
  calculateCrossDayDuration: (start?: Date, stop?: Date) => number
}

export const calculateCrossDayDuration = (startTime?: Date, stopTime?: Date): number => {
  if (!startTime || !stopTime) return 0

  let duration = stopTime.getTime() - startTime.getTime()
  if (duration < 0) {
    duration += 24 * 60 * 60 * 1000
  }
  return duration
}

export class TaskExecutionService {
  constructor(private readonly host: TaskExecutionHost) {}

  async startInstance(inst: TaskInstance): Promise<void> {
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const viewDate = new Date(this.host.getViewDate())
      viewDate.setHours(0, 0, 0, 0)
      if (viewDate.getTime() > today.getTime()) {
        new Notice(
          this.host.tv(
            'notices.futureTaskPreventedWithPeriod',
            'Cannot start a future task.',
          ),
          2000,
        )
        return
      }

      try {
        const currentSlot = getCurrentTimeSlot(new Date())
        if (inst.slotKey !== currentSlot) {
          if (!inst.originalSlotKey) inst.originalSlotKey = inst.slotKey
          inst.slotKey = currentSlot
        }
      } catch {
        /* keep original slot */
      }

      inst.state = 'running'
      inst.startTime = new Date()
      this.host.setCurrentInstance(inst)

      try {
        if (!inst.task.isRoutine && viewDate.getTime() !== today.getTime()) {
          const file = this.host.app.vault.getAbstractFileByPath(inst.task.path)
          if (file instanceof TFile) {
            const y = today.getFullYear()
            const m = String(today.getMonth() + 1).padStart(2, '0')
            const d = String(today.getDate()).toString().padStart(2, '0')
            await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
              frontmatter.target_date = `${y}-${m}-${d}`
              return frontmatter
            })
          }
        }
      } catch {
        /* target date update best effort */
      }

      await this.host.saveRunningTasksState()
      this.host.renderTaskList()
      this.host.startGlobalTimer()
      this.host.restartTimerService()

      new Notice(
        this.host.tv('notices.taskStarted', 'Started {name}', {
          name: inst.task.name,
        }),
      )
    } catch (error) {
      console.error('[TaskExecutionService] startInstance failed', error)
      new Notice(this.host.tv('notices.taskStartFailed', 'Failed to start task'))
    }
  }

  async stopInstance(inst: TaskInstance): Promise<void> {
    try {
      if (inst.state !== 'running') {
        return
      }

      inst.state = 'done'
      inst.stopTime = new Date()

      if (inst.startTime) {
        const duration = this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime)
        inst.actualMinutes = Math.floor(duration / (1000 * 60))
      }

      if (!inst.executedTitle || inst.executedTitle.trim().length === 0) {
        try {
          const resolved = this.host.getInstanceDisplayTitle(inst)
          if (typeof resolved === 'string' && resolved.trim().length > 0) {
            inst.executedTitle = resolved.trim()
          } else if (inst.task?.name) {
            inst.executedTitle = inst.task.name
          }
        } catch {
          if (inst.task?.name) {
            inst.executedTitle = inst.task.name
          }
        }
      }

      if (this.host.getCurrentInstance() === inst) {
        this.host.setCurrentInstance(null)
      }

      const durationSec = Math.floor(
        this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000,
      )
      await this.host.executionLogService.saveTaskLog(inst, durationSec)

      await this.host.saveRunningTasksState()

      const heatmap = new HeatmapService({
        app: this.host.app,
        pathManager: this.host.plugin.pathManager,
      })
      try {
        const start = inst.startTime || new Date()
        const yyyy = start.getFullYear()
        const mm = String(start.getMonth() + 1).padStart(2, '0')
        const dd = String(start.getDate()).toString().padStart(2, '0')
        await heatmap.updateDailyStats(`${yyyy}-${mm}-${dd}`)
      } catch {
        /* ignore heatmap failure */
      }

      this.host.sortTaskInstancesByTimeOrder()
      await this.host.saveTaskOrders()
      this.host.renderTaskList()

      if (this.host.hasRunningInstances()) {
        this.host.restartTimerService()
      } else {
        this.host.stopTimers()
      }

      new Notice(
        this.host.tv('notices.taskCompleted', 'Completed {name} ({minutes} min)', {
          name: inst.task.name,
          minutes: inst.actualMinutes ?? 0,
        }),
      )
    } catch (error) {
      console.error('[TaskExecutionService] stopInstance failed', error)
      new Notice(this.host.tv('notices.taskStopFailed', 'Failed to stop task'))
    }
  }
}

export default TaskExecutionService
