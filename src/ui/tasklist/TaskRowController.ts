import { Notice } from 'obsidian'
import type { TaskInstance } from '../../types'
import { ReminderIconRenderer } from '../../features/reminder/ui/ReminderIconRenderer'

export interface TaskRowControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  startInstance: (inst: TaskInstance) => Promise<void> | void
  stopInstance: (inst: TaskInstance) => Promise<void> | void
  duplicateAndStartInstance: (inst: TaskInstance) => Promise<void> | void
  showTimeEditModal: (inst: TaskInstance) => void
  showReminderSettingsModal: (inst: TaskInstance) => void
  calculateCrossDayDuration: (start: Date, stop: Date) => number
  app: {
    workspace: {
      openLinkText: (path: string, sourcePath: string, newLeaf?: boolean) => Promise<void> | void
    }
  }
}

export default class TaskRowController {
  constructor(private readonly host: TaskRowControllerHost) {}

  renderPlayStopButton(taskItem: HTMLElement, inst: TaskInstance, isFutureTask: boolean): void {
    let cls = 'play-stop-button'
    let label = '▶️'
    let title = this.host.tv('buttons.start', 'Start')

    if (isFutureTask) {
      cls += ' future-task-button'
      label = '—'
      title = this.host.tv('notices.futureTaskPrevented', 'Cannot start future tasks')
    } else if (inst.state === 'running') {
      cls += ' stop'
      label = '⏹'
      title = this.host.tv('buttons.stop', 'Stop')
    } else if (inst.state === 'done') {
      label = '☑️'
      title = this.host.tv('buttons.remeasureCompleted', 'Re-measure completed task')
    }

    const button = taskItem.createEl('button', {
      cls,
      text: label,
      attr: { title },
    })

    if (isFutureTask) {
      button.disabled = true
    }

    button.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (isFutureTask) {
        new Notice(this.host.tv('notices.futureTaskPreventedWithPeriod', 'Cannot start a future task.'), 2000)
        return
      }
      if (inst.state === 'running') {
        await this.host.stopInstance(inst)
      } else if (inst.state === 'idle') {
        await this.host.startInstance(inst)
      } else if (inst.state === 'done') {
        await this.host.duplicateAndStartInstance(inst)
      }
    })
  }

  renderTaskName(taskItem: HTMLElement, inst: TaskInstance): void {
    const displayName = (() => {
      const executed = typeof inst.executedTitle === 'string' ? inst.executedTitle.trim() : ''
      if (inst.state === 'done' && executed.length > 0) {
        return executed
      }
      const displayTitle = typeof inst.task.displayTitle === 'string' ? inst.task.displayTitle.trim() : ''
      if (displayTitle.length > 0) {
        return displayTitle
      }
      return inst.task.name ?? this.host.tv('labels.untitledTask', 'Untitled Task')
    })()

    // Container for task name and reminder icon
    const taskNameContainer = taskItem.createEl('span', {
      cls: 'task-name-container',
    })

    const taskName = taskNameContainer.createEl('span', {
      cls: 'task-name task-name--accent',
      text: displayName,
    })

    taskName.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!inst.task.path) {
        return
      }
      try {
        await this.host.app.workspace.openLinkText(inst.task.path, '', false)
      } catch (error) {
        console.error('Failed to open task file', error)
        new Notice(this.host.tv('notices.taskFileOpenFailed', 'Failed to open task file'))
      }
    })

    // Render reminder icon after task name
    const reminderIconRenderer = new ReminderIconRenderer({
      tv: this.host.tv,
      onClick: (instance) => {
        this.host.showReminderSettingsModal(instance)
      },
    })
    reminderIconRenderer.render(taskNameContainer, inst)
  }

  renderTimeRangeDisplay(taskItem: HTMLElement, inst: TaskInstance): void {
    const timeRangeEl = taskItem.createEl('span', { cls: 'task-time-range' })
    const formatTime = (date: Date) => `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`

    if (inst.startTime && inst.stopTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} → ${formatTime(inst.stopTime)}`
      timeRangeEl.classList.add('editable')
      timeRangeEl.addEventListener('click', (e) => {
        e.stopPropagation()
        this.host.showTimeEditModal(inst)
      })
    } else if (inst.startTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} →`
      timeRangeEl.classList.add('editable')
      timeRangeEl.addEventListener('click', (e) => {
        e.stopPropagation()
        this.host.showTimeEditModal(inst)
      })
    }
  }

  renderDurationDisplay(taskItem: HTMLElement, inst: TaskInstance): void {
    if (inst.state === 'done' && inst.startTime && inst.stopTime) {
      const durationEl = taskItem.createEl('span', { cls: 'task-duration' })
      const duration = this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime)
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      durationEl.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
      if (inst.startTime.getDate() !== inst.stopTime.getDate()) {
        durationEl.setAttribute('title', this.host.tv('tooltips.crossDayTask', 'Cross-day task'))
      }
    } else if (inst.state === 'running') {
      const timerEl = taskItem.createEl('span', { cls: 'task-timer-display' })
      this.updateTimerDisplay(timerEl, inst)
    } else {
      taskItem.createEl('span', { cls: 'task-duration-placeholder' })
    }
  }

  updateTimerDisplay(timerEl: HTMLElement, inst: TaskInstance): void {
    if (!inst.startTime) return
    const now = new Date()
    const elapsed = now.getTime() - inst.startTime.getTime()
    const hours = Math.floor(elapsed / 3600000)
    const minutes = Math.floor((elapsed % 3600000) / 60000)
    const seconds = Math.floor((elapsed % 60000) / 1000)
    timerEl.textContent = `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
}
