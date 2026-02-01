import { Notice, Platform } from 'obsidian'
import type { TaskInstance } from '../../types'
import { ReminderIconRenderer } from '../../features/reminder/ui/ReminderIconRenderer'

export interface TaskRowControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  startInstance: (inst: TaskInstance) => Promise<void> | void
  stopInstance: (inst: TaskInstance) => Promise<void> | void
  duplicateAndStartInstance: (inst: TaskInstance) => Promise<void> | void
  showStartTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
  showStopTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
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

  /**
   * Register both click and touchend events for mobile compatibility.
   * Only triggers on actual taps (not scrolls) by checking touch movement distance.
   */
  private registerTapEvent(element: HTMLElement, handler: (event: Event) => void): void {
    if (Platform?.isMobile) {
      // On mobile, use touchend only to prevent double-firing with click
      const TAP_THRESHOLD = 10
      let touchStartX = 0
      let touchStartY = 0
      let touchHandled = false

      element.addEventListener('touchstart', (event) => {
        touchHandled = false
        if (event.touches.length > 0) {
          touchStartX = event.touches[0].clientX
          touchStartY = event.touches[0].clientY
          event.stopPropagation()
        }
      })

      element.addEventListener('touchend', (event) => {
        event.stopPropagation()
        event.preventDefault() // Prevent subsequent click event

        if (event.changedTouches.length > 0) {
          const touch = event.changedTouches[0]
          const deltaX = Math.abs(touch.clientX - touchStartX)
          const deltaY = Math.abs(touch.clientY - touchStartY)

          if (deltaX > TAP_THRESHOLD || deltaY > TAP_THRESHOLD) {
            return // Scroll, not tap
          }
        }

        touchHandled = true
        handler(event)
      })

      // Fallback click handler in case touch events don't work
      element.addEventListener('click', (event) => {
        if (touchHandled) {
          // Already handled by touchend, ignore click
          touchHandled = false
          event.stopPropagation()
          return
        }
        handler(event)
      })
    } else {
      // On desktop, use click only
      element.addEventListener('click', handler)
    }
  }

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

    this.registerTapEvent(button, (e) => {
      void (async () => {
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
      })()
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
      return inst.task.name ?? this.host.tv('labels.untitledTask', 'Untitled task')
    })()

    // Container for task name and reminder icon
    const taskNameContainer = taskItem.createEl('span', {
      cls: 'task-name-container',
    })

    const taskName = taskNameContainer.createEl('span', {
      cls: 'task-name task-name--accent',
      text: displayName,
    })

    this.registerTapEvent(taskName, (e) => {
      void (async () => {
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
      })()
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

    const startSpan = timeRangeEl.createEl('span', { cls: 'task-time-start editable' })
    const arrowSpan = timeRangeEl.createEl('span', { cls: 'task-time-arrow', text: ' → ' })
    const stopSpan = timeRangeEl.createEl('span', { cls: 'task-time-stop' })

    // Determine if we have actual time values to show
    const hasTimeValues = Boolean(inst.startTime || inst.stopTime)

    if (inst.startTime) {
      startSpan.textContent = formatTime(inst.startTime)
    } else {
      startSpan.textContent = '--:--'
      startSpan.classList.add('idle-placeholder')
    }

    if (inst.startTime && inst.stopTime) {
      stopSpan.textContent = formatTime(inst.stopTime)
      stopSpan.classList.add('editable')
    } else if (inst.startTime && !inst.stopTime) {
      // running state — show clickable placeholder for stop time
      stopSpan.textContent = '--:--'
      stopSpan.classList.add('idle-placeholder', 'editable')
    } else {
      // idle — hide arrow and stop
      arrowSpan.classList.add('is-hidden')
      stopSpan.classList.add('is-hidden')
    }

    // Hide time range by default, show on row hover (unless has values)
    if (!hasTimeValues) {
      timeRangeEl.classList.add('time-hidden')
    }

    this.registerTapEvent(startSpan, (e) => {
      e.stopPropagation()
      this.host.showStartTimePopup(inst, startSpan)
    })

    // Stop span clickable only when startTime exists
    if (inst.startTime) {
      stopSpan.classList.add('editable')
      this.registerTapEvent(stopSpan, (e) => {
        e.stopPropagation()
        this.host.showStopTimePopup(inst, stopSpan)
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
