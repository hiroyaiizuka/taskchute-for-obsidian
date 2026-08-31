import { Notice, Platform } from 'obsidian'
import type { TaskInstance } from '../../types'
import { ReminderIconRenderer } from '../../features/reminder/ui/ReminderIconRenderer'
import { RecipeIconRenderer, type RecipeProgressSummary } from '../../features/recipe/ui/RecipeIconRenderer'

export interface TaskRowControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  startInstance: (inst: TaskInstance) => Promise<void> | void
  stopInstance: (inst: TaskInstance) => Promise<void> | void
  duplicateAndStartInstance: (inst: TaskInstance) => Promise<void> | void
  showStartTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
  showStopTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
  showReminderSettingsModal: (inst: TaskInstance) => void
  getRecipeProgressSummary?: (inst: TaskInstance) => Promise<RecipeProgressSummary | null>
  showRecipeRunPopover?: (inst: TaskInstance, anchor: HTMLElement) => void
  isRecipeFeatureEnabled?: () => boolean
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

  /**
   * Renders the task name and returns its container so callers can append
   * inline companions (reminder/recipe/AI controls) to the name itself rather
   * than to the row's text column, where they would become siblings of the
   * clock and get stacked under it on a phone.
   *
   * @param parent the row's `.task-item__main` column.
   */
  renderTaskName(parent: HTMLElement, inst: TaskInstance): HTMLElement {
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
    const taskNameContainer = parent.createSpan( {
      cls: 'task-name-container',
    })

    const taskName = taskNameContainer.createSpan( {
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

    if (
      (this.host.isRecipeFeatureEnabled?.() ?? true) &&
      this.host.getRecipeProgressSummary &&
      this.host.showRecipeRunPopover
    ) {
      const recipeIconRenderer = new RecipeIconRenderer({
        tv: this.host.tv,
        getSummary: (instance) => this.host.getRecipeProgressSummary!(instance),
        onClick: (instance, anchor) => this.host.showRecipeRunPopover!(instance, anchor),
      })
      recipeIconRenderer.render(taskNameContainer, inst)
    }

    return taskNameContainer
  }

  /** @param parent the row's `.task-item__main` column. */
  renderTimeRangeDisplay(parent: HTMLElement, inst: TaskInstance): void {
    const timeRangeEl = parent.createSpan( { cls: 'task-time-range' })
    const formatTime = (date: Date) => `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`

    const startSpan = timeRangeEl.createSpan({
      cls: 'task-time-start editable',
      attr: { title: this.host.tv('tooltips.startTime', 'Start time') },
    })
    const arrowSpan = timeRangeEl.createSpan( { cls: 'task-time-arrow', text: '→' })
    const stopSpan = timeRangeEl.createSpan({
      cls: 'task-time-stop',
      attr: { title: this.host.tv('tooltips.stopTime', 'End time') },
    })

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

  /**
   * The duration column: elapsed time while running, the measured total once
   * done, and nothing at all otherwise. An idle row used to render an empty
   * `.task-duration-placeholder` here to keep the grid's track count fixed;
   * the row is a flex line now, so an absent element simply takes no width.
   *
   * @param parent the row's `.task-item__main` column.
   */
  renderDurationDisplay(parent: HTMLElement, inst: TaskInstance): void {
    if (inst.state === 'done' && inst.startTime && inst.stopTime) {
      const durationEl = parent.createSpan( { cls: 'task-duration' })
      const duration = this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime)
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      durationEl.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
      const durationLabel = this.host.tv('tooltips.duration', 'Duration')
      const isCrossDay = inst.startTime.getDate() !== inst.stopTime.getDate()
      durationEl.setAttribute(
        'title',
        isCrossDay
          ? `${durationLabel} (${this.host.tv('tooltips.crossDayTask', 'Cross-day task')})`
          : durationLabel,
      )
    } else if (inst.state === 'running') {
      const timerEl = parent.createSpan({
        cls: 'task-timer-display',
        attr: { title: this.host.tv('tooltips.elapsedTime', 'Elapsed time') },
      })
      this.updateTimerDisplay(timerEl, inst)
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
