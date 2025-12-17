import { t } from '../../i18n'
import type { TaskInstance } from '../../types'

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
  openGoogleCalendarExport?: (inst: TaskInstance) => void
  isGoogleCalendarEnabled?: () => boolean
}

export default class TaskSettingsTooltipController {
  constructor(private readonly host: TaskSettingsTooltipHost) {}

  show(inst: TaskInstance, anchor: HTMLElement): void {
    const existing = document.querySelector('.task-settings-tooltip')
    existing?.remove()

    const tooltip = document.createElement('div')
    tooltip.className = 'task-settings-tooltip taskchute-tooltip'

    const header = tooltip.createEl('div', { cls: 'tooltip-header' })
    const closeButton = header.createEl('button', {
      cls: 'tooltip-close-button',
      attr: {
        'aria-label': t('common.close', 'Close'),
        title: t('common.close', 'Close'),
        type: 'button',
      },
    })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line1.setAttribute('x1', '18')
    line1.setAttribute('y1', '6')
    line1.setAttribute('x2', '6')
    line1.setAttribute('y2', '18')
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
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
    this.appendStartTime(inst, tooltip)
    this.appendReminder(inst, tooltip)
    this.appendGoogleCalendar(inst, tooltip)

    const rect = anchor.getBoundingClientRect()
    const width = 200
    const height = 250
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

    document.body.appendChild(tooltip)
    const clickAway = (event: MouseEvent) => {
      if (!tooltip.contains(event.target as Node) && event.target !== anchor) {
        tooltip.remove()
        document.removeEventListener('click', clickAway)
      }
    }
    setTimeout(() => document.addEventListener('click', clickAway), 80)
  }

  private appendReset(inst: TaskInstance, tooltip: HTMLElement): void {
    const label = this.host.tv('buttons.resetToNotStarted', '↩️ Reset to not started')
    const item = tooltip.createEl('div', { cls: 'tooltip-item', text: label })
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

  private appendStartTime(inst: TaskInstance, tooltip: HTMLElement): void {
    const item = tooltip.createEl('div', {
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

    const reminderTime = inst.task.reminder_time
    const hasReminder = typeof reminderTime === 'string' && reminderTime.length > 0

    let label: string
    if (hasReminder) {
      label = this.host.tv('buttons.reminderSet', `⏰ リマインダー (${reminderTime})`, {
        time: reminderTime,
      })
    } else {
      label = this.host.tv('buttons.setReminder', '⏰ リマインダーを設定')
    }

    const item = tooltip.createEl('div', {
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

    const item = tooltip.createEl("div", {
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
    const item = tooltip.createEl('div', {
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
    const item = tooltip.createEl('div', {
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
    const item = tooltip.createEl('div', {
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
