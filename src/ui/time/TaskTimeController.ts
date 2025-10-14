import { Notice, Modal, App } from 'obsidian'
import { getSlotFromTime } from '../../utils/time'
import type { TaskInstance } from '../../types'
import ScheduledTimeModal from '../modals/ScheduledTimeModal'
import TimeEditModal from '../modals/TimeEditModal'

export interface TaskTimeControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: Pick<App, 'vault' | 'fileManager'>
  renderTaskList: () => void
  reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void>
  getInstanceDisplayTitle: (inst: TaskInstance) => string
  persistSlotAssignment: (inst: TaskInstance) => void
  executionLogService: {
    saveTaskLog: (inst: TaskInstance, durationSec: number) => Promise<void>
  }
  calculateCrossDayDuration: (start?: Date, stop?: Date) => number
  saveRunningTasksState: () => Promise<void>
  removeTaskLogForInstanceOnCurrentDate: (instanceId: string) => Promise<void>
  getCurrentDate: () => Date
}

export default class TaskTimeController {
  constructor(private readonly host: TaskTimeControllerHost) {}

  async showScheduledTimeEditModal(inst: TaskInstance): Promise<void> {
    const modal = new ScheduledTimeModal({ host: this.host, instance: inst })
    modal.open()
  }

  showTimeEditModal(inst: TaskInstance): void {
    if (!(inst.startTime && (inst.state === 'running' || inst.state === 'done'))) {
      return
    }

    const modal = new TimeEditModal({
      app: this.host.app as unknown as Modal['app'],
      host: {
        tv: this.host.tv,
        getInstanceDisplayTitle: this.host.getInstanceDisplayTitle,
      },
      instance: inst,
      callbacks: {
        resetTaskToIdle: () => this.resetTaskToIdle(inst),
        updateRunningInstanceStartTime: (startStr) =>
          this.updateRunningInstanceStartTime(inst, startStr),
        transitionToRunningWithStart: (startStr) =>
          this.transitionToRunningWithStart(inst, startStr),
        updateInstanceTimes: (startStr, stopStr) =>
          this.updateInstanceTimes(inst, startStr, stopStr),
      },
    })

    modal.open()
  }

  async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    try {
      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      inst.state = 'idle'
      inst.startTime = undefined
      inst.stopTime = undefined

      if (inst.instanceId) {
        await this.host.removeTaskLogForInstanceOnCurrentDate(inst.instanceId)
      }

      await this.host.saveRunningTasksState()
      this.host.renderTaskList()

      new Notice(
        this.host.tv('notices.restoredToIdle', 'Moved "{title}" back to idle', {
          title: displayTitle,
        }),
      )
    } catch (error) {
      console.error('[TaskTimeController] Failed to reset task', error)
      new Notice(this.host.tv('notices.taskResetFailed', 'Failed to reset task'))
    }
  }

  private async updateInstanceTimes(inst: TaskInstance, startStr: string, stopStr: string): Promise<void> {
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const base = inst.startTime || this.cloneCurrentDate()
    const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10))
    const [eh, em] = stopStr.split(':').map((n) => parseInt(n, 10))

    inst.startTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0, 0)
    inst.stopTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, em, 0, 0)

    if (inst.startTime && inst.stopTime && inst.stopTime <= inst.startTime) {
      inst.stopTime.setDate(inst.stopTime.getDate() + 1)
    }

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.host.persistSlotAssignment(inst)
    }

    const durationSec = Math.floor(this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000)
    await this.host.executionLogService.saveTaskLog(inst, durationSec)
    this.host.renderTaskList()
    new Notice(
      this.host.tv('notices.taskTimesUpdated', 'Updated times for "{title}"', {
        title: displayTitle,
      }),
    )
  }

  private async updateRunningInstanceStartTime(inst: TaskInstance, startStr: string): Promise<void> {
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const base = inst.startTime || this.cloneCurrentDate()
    const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10))
    inst.startTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0, 0)

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.host.persistSlotAssignment(inst)
    }

    await this.host.saveRunningTasksState()
    this.host.renderTaskList()
    new Notice(
      this.host.tv('notices.runningStartUpdated', 'Updated start time for "{title}"', {
        title: displayTitle,
      }),
    )
  }

  private async transitionToRunningWithStart(inst: TaskInstance, startStr: string): Promise<void> {
    if (inst.state !== 'done') return
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const base = inst.startTime || this.cloneCurrentDate()
    const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10))

    if (inst.instanceId) {
      await this.host.removeTaskLogForInstanceOnCurrentDate(inst.instanceId)
    }

    inst.state = 'running'
    inst.startTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0, 0)
    inst.stopTime = undefined

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.host.persistSlotAssignment(inst)
    }

    await this.host.saveRunningTasksState()
    this.host.renderTaskList()
    new Notice(
      this.host.tv('notices.restoredToRunning', 'Moved "{title}" back to running', {
        title: displayTitle,
      }),
    )
  }

  private cloneCurrentDate(): Date {
    const current = this.host.getCurrentDate()
    return new Date(current.getFullYear(), current.getMonth(), current.getDate())
  }
}
