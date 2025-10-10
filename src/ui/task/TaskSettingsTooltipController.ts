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
    }) as HTMLButtonElement
    const dismiss = (event?: Event) => {
      event?.stopPropagation()
      tooltip.remove()
    }
    closeButton.addEventListener('click', dismiss)

    this.appendReset(inst, tooltip)
    this.appendStartTime(inst, tooltip)
    this.appendMove(inst, tooltip, anchor)
    this.appendDuplicate(inst, tooltip)
    void this.appendDelete(inst, tooltip)

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
    item.addEventListener('click', async (event) => {
      event.stopPropagation()
      tooltip.remove()
      await this.host.resetTaskToIdle(inst)
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
    item.addEventListener('click', async (event) => {
      event.stopPropagation()
      tooltip.remove()
      await this.host.showScheduledTimeEditModal(inst)
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
    item.addEventListener('click', async (event) => {
      event.stopPropagation()
      tooltip.remove()
      await this.host.duplicateInstance(inst)
    })
  }

  private async appendDelete(inst: TaskInstance, tooltip: HTMLElement): Promise<void> {
    const item = tooltip.createEl('div', {
      cls: 'tooltip-item delete-item',
      text: this.host.tv('buttons.deleteTask', '🗑️ Delete task'),
    })
    item.addEventListener('click', async (event) => {
      event.stopPropagation()
      tooltip.remove()
      const confirmed = await this.host.showDeleteConfirmDialog(inst)
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
  }
}
