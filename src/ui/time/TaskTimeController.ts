import { Notice } from 'obsidian'
import type { App } from 'obsidian'
import { getSlotFromTime } from '../../utils/time'
import type { TaskInstance } from '../../types'
import ScheduledTimeModal from '../modals/ScheduledTimeModal'
import { createTimePicker } from './TimePickerFactory'
import { resolveStopTimeDate } from '../../utils/resolveStopTimeDate'

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
  stopInstance: (inst: TaskInstance, stopTime?: Date) => Promise<void>
  confirmStopNextDay: () => Promise<boolean>
  setCurrentInstance: (inst: TaskInstance | null) => void
  startGlobalTimer: () => void
  restartTimerService: () => void
  removeTaskLogForInstanceOnCurrentDate: (instanceId: string, taskId?: string) => Promise<void>
  getCurrentDate: () => Date
  disambiguateStopTimeDate?: (sameDayDate: Date, nextDayDate: Date) => Promise<'same-day' | 'next-day' | 'cancel'>
}

export default class TaskTimeController {
  constructor(private readonly host: TaskTimeControllerHost) {}

  showScheduledTimeEditModal(inst: TaskInstance): void {
    const modal = new ScheduledTimeModal({ host: this.host, instance: inst })
    modal.open()
  }

  showStartTimePopup(inst: TaskInstance, anchor: HTMLElement): void {
    const rawViewDate = new Date(this.host.getCurrentDate())
    const viewDate = new Date(rawViewDate)
    viewDate.setHours(0, 0, 0, 0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
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

    const toHM = (date?: Date) =>
      date
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : ''

    const popup = createTimePicker()
    popup.show({
      anchor,
      currentValue: toHM(inst.startTime),
      viewDate: rawViewDate,
      validationDate: inst.startTime ? new Date(inst.startTime) : rawViewDate,
      tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
      onSave: (value: string) => {
        void (async () => {
          if (!value) {
            // Clear start → reset to idle
            if (inst.state === 'running' || inst.state === 'done') {
              await this.resetTaskToIdle(inst)
            }
            return
          }
          if (inst.state === 'idle') {
            await this.transitionToRunningWithStart(inst, value)
          } else if (inst.state === 'running') {
            await this.updateRunningInstanceStartTime(inst, value)
          } else if (inst.state === 'done') {
            const stopStr = toHM(inst.stopTime)
            if (stopStr) {
              const ok = await this.validateStartStopTimes(inst, value, stopStr, rawViewDate)
              if (ok) {
                await this.updateInstanceTimes(inst, value, stopStr)
              }
            } else {
              await this.transitionToRunningWithStart(inst, value)
            }
          }
        })()
      },
      onCancel: () => {},
    })
  }

  showStopTimePopup(inst: TaskInstance, anchor: HTMLElement): void {
    if (!inst.startTime) return

    const viewDate = new Date(this.host.getCurrentDate())
    const toHM = (date?: Date) =>
      date
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : ''

    // For cross-day tasks, use startTime's date for validation
    // so that the time picker doesn't reject past times as "future"
    const isCrossDay = inst.startTime && inst.stopTime
      && !this.isSameDay(inst.startTime, inst.stopTime)
    const validationDate = (() => {
      if (isCrossDay && inst.startTime) {
        return new Date(inst.startTime.getFullYear(), inst.startTime.getMonth(), inst.startTime.getDate())
      }
      return inst.stopTime ? new Date(inst.stopTime) : viewDate
    })()

    const popup = createTimePicker()
    popup.show({
      anchor,
      currentValue: toHM(inst.stopTime),
      viewDate,
      validationDate,
      tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
      onSave: (value: string) => {
        void (async () => {
          const startStr = toHM(inst.startTime)
          if (!value) {
            // Clear stop → back to running (keep start)
            if (inst.state === 'done') {
              await this.transitionToRunningWithStart(inst, startStr)
            }
            return
          }

          // Running state: use existing logic (buildStopTimeFromStart)
          if (inst.state === 'running') {
            if (startStr) {
              const ok = await this.validateStartStopTimes(inst, startStr, value, viewDate)
              if (!ok) return

              const stopTime = this.buildStopTimeFromStart(inst.startTime, value)
              if (stopTime.getTime() > Date.now()) {
                new Notice(
                  this.host.tv(
                    'forms.stopTimeNotFuture',
                    'Stop time cannot be in the future',
                  ),
                )
                return
              }
              await this.host.stopInstance(inst, stopTime)
            }
            return
          }

          // Done state: use resolveStopTimeDate for cross-day handling
          if (startStr && inst.state === 'done') {
            const wasCrossDay = !!(inst.startTime && inst.stopTime
              && !this.isSameDay(inst.startTime, inst.stopTime))

            const resolution = resolveStopTimeDate({
              startTime: inst.startTime!,
              stopTimeStr: value,
              now: new Date(),
              wasCrossDay,
            })

            switch (resolution.type) {
              case 'same-day':
                await this.updateInstanceTimes(inst, startStr, value)
                break
              case 'next-day': {
                const confirmed = await this.host.confirmStopNextDay()
                if (confirmed) {
                  const nextDayStopTime = this.buildStopTimeFromStart(inst.startTime!, value)
                  if (nextDayStopTime.getTime() > Date.now()) {
                    new Notice(
                      this.host.tv('forms.timeNotFuture', 'Time cannot be in the future'),
                    )
                    break
                  }
                  await this.updateInstanceTimes(inst, startStr, value)
                }
                break
              }
              case 'disambiguate': {
                if (this.host.disambiguateStopTimeDate) {
                  const choice = await this.host.disambiguateStopTimeDate(
                    resolution.sameDayDate,
                    resolution.nextDayDate,
                  )
                  if (choice === 'same-day') {
                    await this.updateInstanceTimes(inst, startStr, value)
                  } else if (choice === 'next-day') {
                    await this.updateInstanceTimes(inst, startStr, value, true)
                  }
                  // 'cancel' -> do nothing
                } else {
                  // Fallback: treat as same-day
                  await this.updateInstanceTimes(inst, startStr, value)
                }
                break
              }
              case 'error':
                if (resolution.reason === 'same-time') {
                  new Notice(
                    this.host.tv('forms.startTimeBeforeEnd', 'Scheduled start time must be before end time'),
                  )
                } else {
                  new Notice(
                    this.host.tv('forms.timeNotFuture', 'Time cannot be in the future'),
                  )
                }
                break
            }
            return
          }

          // Fallback for non-done state with startStr
          if (startStr) {
            const ok = await this.validateStartStopTimes(inst, startStr, value, viewDate)
            if (!ok) return
            await this.updateInstanceTimes(inst, startStr, value)
          }
        })()
      },
      onCancel: () => {},
    })
  }

  async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    try {
      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      inst.state = 'idle'
      inst.startTime = undefined
      inst.stopTime = undefined

      if (inst.instanceId) {
        await this.host.removeTaskLogForInstanceOnCurrentDate(inst.instanceId, inst.task?.taskId)
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

  private async updateInstanceTimes(
    inst: TaskInstance,
    startStr: string,
    stopStr: string,
    forceCrossDay = false,
  ): Promise<void> {
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const wasRunning = inst.state === 'running'
    if (inst.state === 'idle' || inst.state === 'running') inst.state = 'done'
    const base = inst.startTime || this.cloneCurrentDate()
    const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10))
    const [eh, em] = stopStr.split(':').map((n) => parseInt(n, 10))

    inst.startTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0, 0)
    inst.stopTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), eh, em, 0, 0)

    if (forceCrossDay || (inst.startTime && inst.stopTime && inst.stopTime <= inst.startTime)) {
      inst.stopTime.setDate(inst.stopTime.getDate() + 1)
    }

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.host.persistSlotAssignment(inst)
    }

    const durationSec = Math.floor(this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000)
    await this.host.executionLogService.saveTaskLog(inst, durationSec)
    if (wasRunning) {
      await this.host.saveRunningTasksState()
    }
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
    if (inst.state !== 'done' && inst.state !== 'idle') return
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const base = inst.startTime || this.cloneCurrentDate()
    const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10))

    if (inst.state !== 'idle' && inst.instanceId) {
      await this.host.removeTaskLogForInstanceOnCurrentDate(inst.instanceId, inst.task?.taskId)
    }

    inst.state = 'running'
    inst.startTime = new Date(base.getFullYear(), base.getMonth(), base.getDate(), sh, sm, 0, 0)
    inst.stopTime = undefined

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.host.persistSlotAssignment(inst)
    }

    const viewDate = this.host.getCurrentDate()
    const isTodayView = this.isSameDay(viewDate, new Date())
    if (isTodayView) {
      this.host.setCurrentInstance(inst)
    }

    await this.host.saveRunningTasksState()
    this.host.renderTaskList()

    if (isTodayView) {
      this.host.startGlobalTimer()
      this.host.restartTimerService()
    }

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

  private isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  }

  private toMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map((n) => parseInt(n, 10))
    return hours * 60 + minutes
  }

  private buildStopTimeFromStart(startTime: Date, stopStr: string): Date {
    const [eh, em] = stopStr.split(':').map((n) => parseInt(n, 10))
    const stopTime = new Date(
      startTime.getFullYear(),
      startTime.getMonth(),
      startTime.getDate(),
      eh,
      em,
      0,
      0,
    )
    if (stopTime <= startTime) {
      stopTime.setDate(stopTime.getDate() + 1)
    }
    return stopTime
  }

  private async validateStartStopTimes(
    _inst: TaskInstance,
    startStr: string,
    stopStr: string,
    _viewDate: Date,
  ): Promise<boolean> {
    const startMinutes = this.toMinutes(startStr)
    const stopMinutes = this.toMinutes(stopStr)

    if (startMinutes === stopMinutes) {
      new Notice(
        this.host.tv('forms.startTimeBeforeEnd', 'Scheduled start time must be before end time'),
      )
      return false
    }

    if (startMinutes > stopMinutes) {
      return this.host.confirmStopNextDay()
    }

    return true
  }
}
