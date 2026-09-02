import 'obsidian'
import type { TaskInstance } from '../../types'
import { normalizeReminderTime } from '../../features/reminder/services/ReminderFrontmatterService'

export interface TaskSettingsTooltipHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  resetTaskToIdle: (inst: TaskInstance) => Promise<void>
  showScheduledTimeEditModal: (inst: TaskInstance) => void | Promise<void>
  showTaskMoveDatePicker: (inst: TaskInstance, anchor: HTMLElement) => void
  duplicateInstance: (inst: TaskInstance) => Promise<TaskInstance | void>
  deleteRoutineTask: (inst: TaskInstance) => Promise<void>
  deleteNonRoutineTask: (inst: TaskInstance) => Promise<void>
  hasExecutionHistory: (path: string) => Promise<boolean>
  showDeleteConfirmDialog: (inst: TaskInstance) => Promise<boolean>
  showReminderSettingsDialog?: (inst: TaskInstance) => void
  showRecipeSelectModal?: (inst: TaskInstance) => void
  hasRecipeAssigned?: (inst: TaskInstance) => boolean
  isRecipeFeatureEnabled?: () => boolean
  openGoogleCalendarExport?: (inst: TaskInstance) => void
  isGoogleCalendarEnabled?: () => boolean
  showProjectModal?: (inst: TaskInstance) => void
}

export default class TaskSettingsTooltipController {
  /** Tears down the menu that is currently open, if any. */
  private activeDismiss: (() => void) | null = null

  constructor(private readonly host: TaskSettingsTooltipHost) {}

  show(inst: TaskInstance, anchor: HTMLElement): void {
    const ownerDocument = anchor.ownerDocument ?? activeDocument
    const ownerWindow = ownerDocument.defaultView ?? window
    this.activeDismiss?.()
    const existing = ownerDocument.querySelector('.task-settings-tooltip')
    existing?.remove()

    const tooltip = createDiv()
    tooltip.className = 'task-settings-tooltip taskchute-tooltip'

    // No close button: it never drew on a tablet, and a menu that closes on
    // the next tap anywhere -- plus Escape -- does not need a second, weaker
    // way out taking up a header row above the first item.
    this.appendMove(inst, tooltip, anchor)
    this.appendDuplicate(inst, tooltip)
    void this.appendDelete(inst, tooltip)
    this.appendReset(inst, tooltip)
    this.appendProject(inst, tooltip)
    this.appendRecipe(inst, tooltip)
    this.appendStartTime(inst, tooltip)
    this.appendReminder(inst, tooltip)
    this.appendGoogleCalendar(inst, tooltip)

    // Add tooltip to DOM first to measure actual dimensions
    tooltip.classList.add('is-measuring')
    ownerDocument.body.appendChild(tooltip)

    const rect = anchor.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const width = Math.max(tooltipRect.width, tooltip.scrollWidth, tooltip.offsetWidth)
    const height = Math.max(tooltipRect.height, tooltip.scrollHeight, tooltip.offsetHeight)

    let top = rect.bottom + 5
    if (top + height > ownerWindow.innerHeight) {
      top = Math.max(rect.top - height - 5, 0)
    }
    let left = rect.left
    if (left + width > ownerWindow.innerWidth) {
      left = Math.max(ownerWindow.innerWidth - width - 10, 0)
    }
    tooltip.style.setProperty('--taskchute-tooltip-left', `${left}px`)
    tooltip.style.setProperty('--taskchute-tooltip-top', `${top}px`)
    tooltip.classList.remove('is-measuring')

    const dismiss = () => {
      tooltip.remove()
      ownerDocument.removeEventListener('pointerdown', handleOutsideInteraction)
      ownerDocument.removeEventListener('keydown', handleKeydown)
      if (this.activeDismiss === dismiss) {
        this.activeDismiss = null
      }
    }

    const handleOutsideInteraction = (event: Event) => {
      // A menu item's own handler removes the tooltip without going through
      // dismiss(), so the listeners outlive it; clear them on the next event.
      if (!tooltip.isConnected) {
        dismiss()
        return
      }
      const target = event.target
      if (!(target instanceof Node)) return
      if (tooltip.contains(target) || target === anchor || anchor.contains(target)) return
      dismiss()
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss()
    }

    // `pointerdown` rather than click + touchend: one event for a mouse, a pen
    // and a finger alike, which is also what removes the need for the timing
    // guard the two-listener version needed to ignore its own opening tap.
    // The tap that opened this menu is a `click`, so it is already past.
    ownerDocument.addEventListener('pointerdown', handleOutsideInteraction)
    ownerDocument.addEventListener('keydown', handleKeydown)
    this.activeDismiss = dismiss
  }

  private appendReset(inst: TaskInstance, tooltip: HTMLElement): void {
    const label = this.host.tv('buttons.resetToNotStarted', '↩️ Reset to not started')
    const item = tooltip.createDiv( { cls: 'tooltip-item', text: label })
    if (inst.state === 'idle') {
      item.classList.add('disabled')
      item.setAttribute('title', this.host.tv('forms.feedbackPrompt', 'This task is not started'))
      return
    }
    item.setAttribute('title', this.host.tv('forms.feedbackDescription', 'Reset the task to its pre-start state'))
    item.addEventListener('click', (event) => {
      void (async () => {
        event.stopPropagation()
        tooltip.remove()
        await this.host.resetTaskToIdle(inst)
      })()
    })
  }

  private appendProject(inst: TaskInstance, tooltip: HTMLElement): void {
    if (!this.host.showProjectModal) {
      return
    }

    const label = this.host.tv('buttons.setProject', '📁 Set project')

    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: label,
      attr: {
        title: this.host.tv('forms.projectDescription', 'Assign or change project'),
      },
    })

    item.addEventListener('click', (event) => {
      event.stopPropagation()
      tooltip.remove()
      this.host.showProjectModal!(inst)
    })
  }

  private appendRecipe(inst: TaskInstance, tooltip: HTMLElement): void {
    if (!this.host.showRecipeSelectModal) {
      return
    }
    if (this.host.isRecipeFeatureEnabled && !this.host.isRecipeFeatureEnabled()) {
      return
    }
    const hasRecipe = this.host.hasRecipeAssigned
      ? this.host.hasRecipeAssigned(inst)
      : Boolean(inst.task.recipePath)
    const label = hasRecipe
      ? this.host.tv('buttons.manageRecipe', '🍽 Change or remove recipe')
      : this.host.tv('buttons.setRecipe', '🍽 Set recipe')
    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: label,
      attr: {
        title: this.host.tv('forms.recipeDescription', 'Assign a reusable recipe to this task'),
      },
    })
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      tooltip.remove()
      this.host.showRecipeSelectModal!(inst)
    })
  }

  private appendStartTime(inst: TaskInstance, tooltip: HTMLElement): void {
    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: this.host.tv('buttons.setStartTime', '🕐 Set start time'),
      attr: {
        title: this.host.tv('forms.startTimeInfo', 'Set the scheduled start time. Leave empty to clear it.'),
      },
    })
    item.addEventListener('click', (event) => {
      void (async () => {
        event.stopPropagation()
        tooltip.remove()
        await this.host.showScheduledTimeEditModal(inst)
      })()
    })
  }

  private appendReminder(inst: TaskInstance, tooltip: HTMLElement): void {
    // Skip if host doesn't support reminder settings
    if (!this.host.showReminderSettingsDialog) {
      return
    }

    const reminderTime = normalizeReminderTime(inst.task.reminder_time)
    const hasReminder = reminderTime !== undefined

    let label: string
    if (hasReminder) {
      label = this.host.tv('buttons.reminderSet', "⏰ Reminder ({time})", {
        time: reminderTime,
      })
    } else {
      label = this.host.tv('buttons.setReminder', '⏰ Set reminder')
    }

    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: label,
      attr: {
        title: this.host.tv(
          'forms.reminderDescription',
          'Set a reminder notification time'
        ),
      },
    })

    item.addEventListener('click', (event) => {
      event.stopPropagation()
      tooltip.remove()
      this.host.showReminderSettingsDialog!(inst)
    })
  }

  private appendGoogleCalendar(inst: TaskInstance, tooltip: HTMLElement): void {
    if (!this.host.openGoogleCalendarExport) return

    const enabled = this.host.isGoogleCalendarEnabled
      ? this.host.isGoogleCalendarEnabled()
      : false

    if (!enabled) {
      return
    }

    const item = tooltip.createDiv( {
      cls: "tooltip-item",
      text: this.host.tv("calendar.export.toGoogle", "🗓️ Register calendar"),
      attr: {
        title: this.host.tv(
          "calendar.export.tooltip",
          "Open Google Calendar in browser",
        ),
      },
    })

    item.addEventListener("click", (event) => {
      event.stopPropagation()
      tooltip.remove()
      this.host.openGoogleCalendarExport?.(inst)
    })
  }

  private appendMove(inst: TaskInstance, tooltip: HTMLElement, anchor: HTMLElement): void {
    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: this.host.tv('buttons.moveTask', '📅 Move task'),
      attr: {
        title: this.host.tv('forms.moveDescription', 'Move the task to another date'),
      },
    })
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      tooltip.remove()
      this.host.showTaskMoveDatePicker(inst, anchor)
    })
  }

  private appendDuplicate(inst: TaskInstance, tooltip: HTMLElement): void {
    const item = tooltip.createDiv( {
      cls: 'tooltip-item',
      text: this.host.tv('buttons.duplicateTask', '📄 Duplicate task'),
      attr: {
        title: this.host.tv('forms.duplicateDescription', 'Insert a duplicate task below'),
      },
    })
    item.addEventListener('click', (event) => {
      void (async () => {
        event.stopPropagation()
        tooltip.remove()
        await this.host.duplicateInstance(inst)
      })()
    })
  }

  private appendDelete(inst: TaskInstance, tooltip: HTMLElement): void {
    const item = tooltip.createDiv( {
      cls: 'tooltip-item delete-item',
      text: this.host.tv('buttons.deleteTask', '🗑️ Delete task'),
    })
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      tooltip.remove()
      void this.host.showDeleteConfirmDialog(inst).then(async (confirmed) => {
        if (!confirmed) {
          return
        }

        const hasHistory = await this.host.hasExecutionHistory(inst.task.path ?? '')
        if (inst.task.isRoutine || hasHistory) {
          await this.host.deleteRoutineTask(inst)
        } else {
          await this.host.deleteNonRoutineTask(inst)
        }
      })
    })
  }
}
