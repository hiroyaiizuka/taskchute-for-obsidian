import 'obsidian'
import { t } from '../../i18n'
import type { TaskInstance } from '../../types'
import { normalizeReminderTime } from '../../features/reminder/services/ReminderFrontmatterService'

export interface TaskSettingsTooltipHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  resetTaskToIdle: (inst: TaskInstance) => Promise<void>
  showScheduledTimeEditModal: (inst: TaskInstance) => Promise<void>
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
  constructor(private readonly host: TaskSettingsTooltipHost) {}

  show(inst: TaskInstance, anchor: HTMLElement): void {
    const existing = document.querySelector('.task-settings-tooltip')
    existing?.remove()

    const tooltip = createDiv()
    tooltip.className = 'task-settings-tooltip taskchute-tooltip'

    const header = tooltip.createDiv( { cls: 'tooltip-header' })
    const closeButton = header.createEl('button', {
      cls: 'tooltip-close-button',
      attr: {
        'aria-label': t('common.close', 'Close'),
        title: t('common.close', 'Close'),
        type: 'button',
      },
    })
    const svg = createSvg('svg')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const line1 = createSvg('line')
    line1.setAttribute('x1', '18')
    line1.setAttribute('y1', '6')
    line1.setAttribute('x2', '6')
    line1.setAttribute('y2', '18')
    const line2 = createSvg('line')
    line2.setAttribute('x1', '6')
    line2.setAttribute('y1', '6')
    line2.setAttribute('x2', '18')
    line2.setAttribute('y2', '18')
    svg.appendChild(line1)
    svg.appendChild(line2)
    closeButton.appendChild(svg)
    const dismiss = (event?: Event) => {
      event?.stopPropagation()
      tooltip.remove()
    }
    closeButton.addEventListener('click', dismiss)

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
    document.body.appendChild(tooltip)

    const rect = anchor.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const width = Math.max(tooltipRect.width, tooltip.scrollWidth, tooltip.offsetWidth)
    const height = Math.max(tooltipRect.height, tooltip.scrollHeight, tooltip.offsetHeight)

    let top = rect.bottom + 5
    if (top + height > window.innerHeight) {
      top = Math.max(rect.top - height - 5, 0)
    }
    let left = rect.left
    if (left + width > window.innerWidth) {
      left = Math.max(window.innerWidth - width - 10, 0)
    }
    tooltip.style.setProperty('--taskchute-tooltip-left', `${left}px`)
    tooltip.style.setProperty('--taskchute-tooltip-top', `${top}px`)
    tooltip.classList.remove('is-measuring')

    // Click-away to close (with mobile touch support)
    // Record open time to ignore events from the same interaction that opened the tooltip
    const openTime = Date.now()
    const DEBOUNCE_MS = 150 // Ignore events within 150ms of opening

    const handleOutsideInteraction = (event: MouseEvent | TouchEvent) => {
      // Ignore events that happen too soon after opening (same interaction)
      if (Date.now() - openTime < DEBOUNCE_MS) return

      const target = event.target as Node
      if (!tooltip.contains(target) && target !== anchor) {
        tooltip.remove()
        document.removeEventListener('click', handleOutsideInteraction)
        document.removeEventListener('touchend', handleOutsideInteraction)
      }
    }

    // Register both click and touchend for better mobile support
    document.addEventListener('click', handleOutsideInteraction)
    document.addEventListener('touchend', handleOutsideInteraction)
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
      ? this.host.tv('buttons.changeRecipe', '🍽 レシピを変更')
      : this.host.tv('buttons.setRecipe', '🍽 レシピを設定')
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
      label = this.host.tv('buttons.reminderSet', `⏰ リマインダー (${reminderTime})`, {
        time: reminderTime,
      })
    } else {
      label = this.host.tv('buttons.setReminder', '⏰ リマインダーを設定')
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
      text: this.host.tv("calendar.export.toGoogle", "🗓️ register calender"),
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
