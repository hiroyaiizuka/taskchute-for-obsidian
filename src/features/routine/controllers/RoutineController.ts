import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import { t } from '../../../i18n'
import { applyRoutineFrontmatterMerge } from '../utils/RoutineFrontmatterUtils'
import { TaskValidator } from '../../core/services/TaskValidator'
import type { RoutineFrontmatter, TaskChutePluginLike, TaskData } from '../../../types'
import type { RoutineWeek } from '../../../types/TaskFields'
import type { RoutineTaskShape } from '../../../types/Routine'
import { setScheduledTime } from '../../../utils/fieldMigration'
import {
  deriveRoutineModalTitle,
  deriveWeeklySelection,
  deriveMonthlySelection,
} from '../modals/RoutineModal'

type CreateOptions = {
  cls?: string
  text?: string
  attr?: Record<string, string | number | boolean>
  type?: string
  value?: string
}

type RoutineKind = NonNullable<RoutineTaskShape['routine_type']>

interface RoutineDetailsInput {
  weekdays?: number[]
  monthly_week?: number | 'last'
  monthly_weekday?: number
  interval?: number
  enabled?: boolean
}

export interface RoutineControllerHost {
  app: App
  plugin: TaskChutePluginLike
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getWeekdayNames: () => string[]
  reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void>
  getCurrentDate: () => Date
}

export default class RoutineController {
  constructor(private readonly host: RoutineControllerHost) {}

  showRoutineEditModal(task: RoutineTaskShape, anchor?: HTMLElement): void {
    this.ensureDomHelpers()
    const modal = document.createElement('div')
    modal.className = 'task-modal-overlay'
    const modalContent = modal.createEl('div', { cls: 'task-modal-content' })

    const modalHeader = modalContent.createEl('div', { cls: 'modal-header' })
    const taskTitle = deriveRoutineModalTitle(task as TaskData)
    modalHeader.createEl('h3', {
      text: t('routineEdit.title', `Routine settings for "${taskTitle}"`, {
        name: taskTitle,
      }),
    })

    const closeButton = modalHeader.createEl('button', {
      cls: 'modal-close-button',
      attr: {
        'aria-label': this.tv('common.close', 'Close'),
        title: this.tv('common.close', 'Close'),
        type: 'button',
      },
    }) as HTMLButtonElement

    const form = modalContent.createEl('form', { cls: 'task-form' })
    const typeGroup = form.createEl('div', { cls: 'form-group' })
    typeGroup.createEl('label', {
      text: this.tv('forms.routineType', 'Routine type:'),
      cls: 'form-label',
    })
    const typeSelect = typeGroup.createEl('select', {
      cls: 'form-input',
    }) as HTMLSelectElement

    const options = [
      { value: 'daily', text: this.tv('forms.routineDaily', 'Daily') },
      { value: 'weekly', text: this.tv('forms.routineWeekly', 'Weekly (by weekday)') },
      { value: 'monthly', text: this.tv('forms.routineMonthly', 'Monthly (weekday)') },
    ]
    options.forEach((opt) => {
      const option = typeSelect.createEl('option', {
        value: opt.value,
        text: opt.text,
      })
      if ((task.routine_type ?? task.frontmatter?.routine_type) === opt.value) {
        option.selected = true
      }
    })
    typeSelect.value =
      task.routine_type === 'weekly' || task.routine_type === 'monthly'
        ? task.routine_type
        : 'daily'

    const timeGroup = form.createEl('div', { cls: 'form-group' })
    timeGroup.createEl('label', {
      text: this.tv('forms.scheduledTimeLabel', 'Scheduled start time:'),
      cls: 'form-label',
    })
    const timeInput = timeGroup.createEl('input', {
      type: 'time',
      cls: 'form-input',
      value: this.resolveScheduledTimeValue(task),
    }) as HTMLInputElement

    const intervalGroup = form.createEl('div', { cls: 'form-group' })
    intervalGroup.createEl('label', {
      text: this.tv('forms.interval', 'Interval:'),
      cls: 'form-label',
    })
    const intervalInput = intervalGroup.createEl('input', {
      type: 'number',
      cls: 'form-input',
      attr: { min: '1', step: '1' },
      value: String(task.routine_interval ?? 1),
    }) as HTMLInputElement

    const enabledGroup = form.createEl('div', { cls: 'form-group' })
    enabledGroup.createEl('label', {
      text: this.tv('forms.enabled', 'Enabled:'),
      cls: 'form-label',
    })
    const enabledToggle = enabledGroup.createEl('input', {
      type: 'checkbox',
    }) as HTMLInputElement
    enabledToggle.checked = task.routine_enabled !== false

    const weeklyGroup = form.createEl('div', {
      cls: 'form-group routine-weekly-group',
    })
    weeklyGroup.classList.add('is-hidden')
    weeklyGroup.createEl('label', {
      text: this.tv('forms.selectWeekdays', 'Select weekdays:'),
      cls: 'form-label',
    })
    const weekdayContainer = weeklyGroup.createEl('div', {
      cls: 'weekday-checkboxes',
    })

    const weekdays = this.getWeekdayNames().map((label, value) => ({ value, label }))
    const weekdayCheckboxes: HTMLInputElement[] = []
    weekdays.forEach((day) => {
      const label = weekdayContainer.createEl('label', {
        cls: 'weekday-checkbox-label',
      })
      const checkbox = label.createEl('input', {
        type: 'checkbox',
        value: String(day.value),
      }) as HTMLInputElement
      weekdayCheckboxes.push(checkbox)
      label.createEl('span', { text: day.label })
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          weekdayCheckboxes.forEach((cb) => {
            if (cb !== checkbox) cb.checked = false
          })
        }
      })
    })
    deriveWeeklySelection(task as TaskData).forEach((day) => {
      const checkbox = weekdayCheckboxes[day]
      if (checkbox) checkbox.checked = true
    })

    const monthlyGroup = form.createEl('div', {
      cls: 'form-group routine-monthly-group',
    })
    monthlyGroup.classList.add('is-hidden')
    monthlyGroup.createEl('label', {
      text: this.tv('forms.monthlySettings', 'Monthly settings:'),
      cls: 'form-label',
    })
    const monthlyContainer = monthlyGroup.createEl('div', {
      cls: 'monthly-settings',
    })
    monthlyContainer.createEl('span', {
      text: this.tv('forms.nth', 'Nth'),
    })
    const weekSelect = monthlyContainer.createEl('select', {
      cls: 'form-input monthly-settings__week',
    }) as HTMLSelectElement
    for (let i = 1; i <= 5; i++) {
      weekSelect.createEl('option', {
        value: String(i - 1),
        text: String(i),
      })
    }
    weekSelect.createEl('option', {
      value: 'last',
      text: this.tv('forms.lastWeek', 'Last'),
    })
    monthlyContainer.createEl('span', {
      text: this.tv('forms.weekOf', ' week'),
    })
    const monthlyWeekdaySelect = monthlyContainer.createEl('select', {
      cls: 'form-input monthly-settings__weekday',
    }) as HTMLSelectElement
    weekdays.forEach((day) => {
      monthlyWeekdaySelect.createEl('option', {
        value: String(day.value),
        text: `${day.label}${this.tv('forms.weekdaySuffix', ' weekday')}`,
      })
    })
    const { week: initialMonthWeek, weekday: initialMonthWeekday } = deriveMonthlySelection(task as TaskData)
    if (initialMonthWeek === 'last') {
      weekSelect.value = 'last'
    } else if (typeof initialMonthWeek === 'number') {
      const zeroBased = Math.max(0, Math.min(4, initialMonthWeek - 1))
      weekSelect.value = String(zeroBased)
    }
    if (typeof initialMonthWeekday === 'number') {
      monthlyWeekdaySelect.value = String(initialMonthWeekday)
    }

    const syncVisibility = () => {
      const selectedType = typeSelect.value
      weeklyGroup.classList.toggle('is-hidden', selectedType !== 'weekly')
      monthlyGroup.classList.toggle('is-hidden', selectedType !== 'monthly')
    }
    syncVisibility()
    typeSelect.addEventListener('change', syncVisibility)

    const buttonGroup = form.createEl('div', { cls: 'form-button-group' })
    const cancelButton = buttonGroup.createEl('button', {
      type: 'button',
      cls: 'form-button cancel',
      text: t('common.cancel', 'Cancel'),
    })
    buttonGroup.createEl('button', {
      type: 'submit',
      cls: 'form-button create',
      text: this.tv('buttons.save', 'Save'),
    })
    let removeButton: HTMLButtonElement | null = null
    if (task.isRoutine) {
      removeButton = buttonGroup.createEl('button', {
        type: 'button',
        cls: 'form-button cancel',
        text: this.tv('buttons.removeRoutine', 'Remove from routine'),
      }) as HTMLButtonElement
    }

    const closeModal = () => {
      modal.remove()
    }
    closeButton.addEventListener('click', closeModal)
    cancelButton.addEventListener('click', closeModal)

    if (removeButton) {
      removeButton.addEventListener('click', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        await this.toggleRoutine(task, anchor ?? removeButton)
        closeModal()
      })
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const scheduledTime = timeInput.value
      const routineType = this.normalizeRoutineType(typeSelect.value)
      const interval = Math.max(1, Number.parseInt(intervalInput.value || '1', 10) || 1)
      const enabled = enabledToggle.checked
      if (!scheduledTime) {
        new Notice(this.tv('forms.scheduledTimePlaceholder', 'Enter a scheduled start time'))
        return
      }
      if (routineType === 'weekly') {
        const selected = weekdayCheckboxes.filter((cb) => cb.checked)
        if (selected.length === 0) {
          new Notice(this.tv('forms.selectWeekdaysPrompt', 'Please select at least one weekday'))
          return
        }
      }
      const detailPayload: RoutineDetailsInput = {
        interval,
        enabled,
      }

      if (routineType === 'weekly') {
        detailPayload.weekdays = weekdayCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => Number.parseInt(cb.value, 10))
          .filter((value) => Number.isInteger(value))
      } else if (routineType === 'monthly') {
        if (weekSelect.value === 'last') {
          detailPayload.monthly_week = 'last'
        } else {
          const parsedWeek = Number.parseInt(weekSelect.value, 10)
          if (!Number.isNaN(parsedWeek) && parsedWeek >= 1 && parsedWeek <= 5) {
            detailPayload.monthly_week = parsedWeek - 1
          }
        }

        const parsedWeekday = Number.parseInt(monthlyWeekdaySelect.value, 10)
        if (!Number.isNaN(parsedWeekday) && parsedWeekday >= 0 && parsedWeekday <= 6) {
          detailPayload.monthly_weekday = parsedWeekday
        }
      }

      await this.setRoutineTaskWithDetails(task, anchor ?? modalContent, scheduledTime, routineType, detailPayload)
      closeModal()
    })

    document.body.appendChild(modal)
    timeInput.focus()
  }

  async toggleRoutine(task: RoutineTaskShape, button?: HTMLElement): Promise<void> {
    try {
      if (task.isRoutine) {
        const file = this.resolveTaskFile(task)
        if (!file) {
          this.notifyFileMissing(task)
          return
        }
        await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const today = this.formatCurrentDate()
          frontmatter.routine_end = today
          frontmatter.isRoutine = false
          setScheduledTime(frontmatter, undefined)
          return frontmatter
        })
        task.isRoutine = false
        task.scheduledTime = undefined
        task.routine_enabled = false
        button?.classList.remove('active')
        button?.setAttribute('title', this.tv('tooltips.routineSet', 'Set as routine'))
        await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
        new Notice(this.tv('notices.routineDetached', 'Detached from routine'))
      } else {
        this.showRoutineEditModal(task, button)
      }
    } catch (error) {
      console.error('[TaskChute] toggleRoutine failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.routineSetFailed', 'Failed to set routine task: {message}', {
          message,
        }),
      )
    }
  }

  async setRoutineTaskWithDetails(
    task: RoutineTaskShape,
    button: HTMLElement,
    scheduledTime: string,
    routineType: RoutineKind,
    details: RoutineDetailsInput,
  ): Promise<void> {
    try {
      const fallbackTitle = this.getTaskTitle(task)
      const file = this.resolveTaskFile(task)
      if (!file) {
        this.notifyFileMissing(task, fallbackTitle)
        return
      }
      await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const today = this.formatCurrentDate()
        const changes: Record<string, unknown> = {
          isRoutine: true,
          routine_type: routineType,
          routine_enabled: details.enabled !== false,
          routine_interval: Math.max(1, details.interval || 1),
          routine_start: today,
        }
        setScheduledTime(changes, scheduledTime, { preferNew: true })
        const routineFrontmatter = frontmatter as RoutineFrontmatter
        const cleaned = TaskValidator.cleanupOnRoutineChange(routineFrontmatter, changes)
        delete cleaned.routine_end
        delete cleaned.weekday
        delete cleaned.weekdays
        delete cleaned.monthly_week
        delete cleaned.monthly_weekday
        delete cleaned.routine_week
        delete cleaned.routine_weekday
        applyRoutineFrontmatterMerge(routineFrontmatter, cleaned)
        if (routineType === 'weekly' && details.weekdays?.length) {
          routineFrontmatter.routine_weekday = details.weekdays[0]
        } else if (routineType === 'monthly') {
          let routineWeek: RoutineWeek | undefined
          if (details.monthly_week === 'last') {
            routineWeek = 'last'
          } else if (typeof details.monthly_week === 'number') {
            const normalizedWeek = details.monthly_week + 1
            if (normalizedWeek >= 1 && normalizedWeek <= 5) {
              routineWeek = normalizedWeek as RoutineWeek
            }
          }
          if (routineWeek) {
            routineFrontmatter.routine_week = routineWeek
          } else {
            delete routineFrontmatter.routine_week
          }
          if (typeof details.monthly_weekday === 'number') {
            routineFrontmatter.routine_weekday = details.monthly_weekday
          }
        }
        return routineFrontmatter
      })
      task.isRoutine = true
      task.scheduledTime = scheduledTime
      task.routine_type = routineType
      task.routine_interval = Math.max(1, details.interval || 1)
      task.routine_enabled = details.enabled !== false
      this.assignRoutineDetails(task, routineType, details)
      button?.classList.add('active')
      const tooltipText = this.buildRoutineTooltip(task, routineType, scheduledTime, details)
      button?.setAttribute('title', tooltipText)
      await this.host.reloadTasksAndRestore({ runBoundaryCheck: true })
      const successTitle = this.getTaskTitle(task)
      new Notice(
        this.tv('notices.routineSetSuccess', 'Set "{title}" as a routine task (starts at {time})', {
          title: successTitle,
          time: scheduledTime,
        }),
      )
    } catch (error) {
      console.error('Failed to set routine task:', error)
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.routineSetFailed', 'Failed to set routine task: {message}', {
          message,
        }),
      )
    }
  }

  private tv(key: string, fallback: string, vars?: Record<string, string | number>): string {
    return this.host.tv(key, fallback, vars)
  }

  private getWeekdayNames(): string[] {
    return this.host.getWeekdayNames()
  }

  private getTaskTitle(task: RoutineTaskShape): string {
    const candidates: unknown[] = [
      task.title,
      task.displayTitle,
      task.name,
      typeof task.path === 'string'
        ? task.path.split('/').pop()?.replace(/\.md$/u, '')
        : undefined,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim()
        if (trimmed.length > 0) {
          return trimmed
        }
      }
    }
    return 'Untitled Task'
  }

  private resolveTaskFile(task: RoutineTaskShape): TFile | null {
    if (task.file && task.file instanceof TFile) {
      return task.file
    }
    if (task.path) {
      const byPath = this.host.app.vault.getAbstractFileByPath(task.path)
      if (byPath && byPath instanceof TFile) {
        return byPath
      }
    }
    const fallbackBase = this.getTaskTitle(task)
    const taskFolderPath = this.host.plugin.pathManager.getTaskFolderPath()
    const fallbackPath = `${taskFolderPath}/${fallbackBase}.md`
    const fallbackFile = this.host.app.vault.getAbstractFileByPath(fallbackPath)
    if (fallbackFile && fallbackFile instanceof TFile) {
      return fallbackFile
    }
    return null
  }

  private notifyFileMissing(task: RoutineTaskShape, fallback?: string): void {
    const title = fallback ?? this.getTaskTitle(task)
    new Notice(
      this.tv('project.fileMissing', 'Task file "{title}.md" not found', {
        title,
      }),
    )
  }

  private formatCurrentDate(): string {
    const current = this.host.getCurrentDate()
    const y = current.getFullYear()
    const m = String(current.getMonth() + 1).padStart(2, '0')
    const d = String(current.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  private assignRoutineDetails(
    task: RoutineTaskShape,
    routineType: RoutineKind,
    details: RoutineDetailsInput,
  ): void {
    if (routineType === 'weekly') {
      const selected = Array.isArray(details.weekdays)
        ? details.weekdays.filter((value) => Number.isInteger(value))
        : []
      task.weekdays = selected
      if (selected.length > 0) {
        task.weekday = selected[0]
        task.routine_weekday = selected[0]
      } else {
        delete task.weekday
        delete task.routine_weekday
      }
      delete task.routine_week
      delete task.monthly_week
      delete task.monthly_weekday
    } else if (routineType === 'monthly') {
      if (details.monthly_week !== undefined) {
        if (details.monthly_week === 'last') {
          task.monthly_week = 'last'
          task.routine_week = 'last'
        } else if (typeof details.monthly_week === 'number') {
          const normalizedWeek = details.monthly_week + 1
          if (normalizedWeek >= 1 && normalizedWeek <= 5) {
            task.monthly_week = normalizedWeek as RoutineWeek
            task.routine_week = normalizedWeek as RoutineWeek
          } else {
            delete task.monthly_week
            delete task.routine_week
          }
        }
      } else {
        delete task.monthly_week
        delete task.routine_week
      }
      if (typeof details.monthly_weekday === 'number') {
        task.monthly_weekday = details.monthly_weekday
        task.routine_weekday = details.monthly_weekday
      } else {
        delete task.monthly_weekday
        delete task.routine_weekday
      }
      delete task.weekday
      delete task.weekdays
    } else {
      delete task.weekday
      delete task.weekdays
      delete task.monthly_week
      delete task.monthly_weekday
      delete task.routine_week
      delete task.routine_weekday
    }
  }

  private buildRoutineTooltip(
    task: RoutineTaskShape,
    routineType: RoutineKind,
    scheduledTime: string,
    details: RoutineDetailsInput,
  ): string {
    let tooltip = this.tv('tooltips.routineScheduled', 'Routine task (starts at {time})', {
      time: scheduledTime,
    })
    const intervalValue = task.routine_interval || details.interval || 1
    switch (routineType) {
      case 'daily':
        tooltip += ` - ${this.tv('labels.routineDailyLabel', 'Every {interval} day(s)', {
          interval: intervalValue,
        })}`
        break
      case 'weekdays':
        tooltip += this.tv('lists.weekdaysOnlySuffix', ' - Weekdays only')
        break
      case 'weekends':
        tooltip += this.tv('lists.weekendsOnlySuffix', ' - Weekends only')
        break
      case 'weekly': {
        if (details.weekdays?.length) {
          const dayNames = this.getWeekdayNames()
          const selectedDay =
            typeof details.weekdays[0] === 'number'
              ? dayNames[details.weekdays[0]]
              : this.tv('labels.routineDayUnset', 'No weekday set')
          tooltip += ` - ${this.tv('labels.routineWeeklyLabel', 'Every {interval} week(s) on {day}', {
            interval: intervalValue,
            day: selectedDay,
          })}`
        }
        break
      }
      case 'monthly': {
        if (details.monthly_week !== undefined && details.monthly_weekday !== undefined) {
          const dayNames = this.getWeekdayNames()
          const weekLabel =
            details.monthly_week === 'last'
              ? this.tv('labels.routineWeekLast', 'Last week')
              : this.tv('labels.routineWeekNth', 'Week {week}', {
                  week: (details.monthly_week as number) + 1,
                })
          const dayLabel =
            typeof details.monthly_weekday === 'number'
              ? dayNames[details.monthly_weekday]
              : this.tv('labels.routineDayUnset', 'No weekday set')
          const monthlyLabel = this.tv('labels.routineMonthlyLabel', 'Every {interval} month(s) on {week} {day}', {
            interval: intervalValue,
            week: weekLabel,
            day: dayLabel,
          })
          tooltip += ` - ${monthlyLabel.replace(/\s{2,}/g, ' ').trim()}`
        }
        break
      }
      default:
        break
    }
    return tooltip
  }

  private ensureDomHelpers(): void {
    const proto = HTMLElement.prototype as unknown as {
      createEl?: (tag: string, options?: CreateOptions) => HTMLElement
    }
    if (typeof proto.createEl === 'function') {
      return
    }
    proto.createEl = function (this: HTMLElement, tag: string, options: CreateOptions = {}) {
      const element = document.createElement(tag)
      const cls = options.cls
      if (cls) {
        element.className = cls
      }
      const text = options.text
      if (typeof text === 'string') {
        element.textContent = text
      }
      const value = options.value
      if (typeof value === 'string' && 'value' in element) {
        ;(element as HTMLInputElement).value = value
      }
      const type = options.type
      if (typeof type === 'string' && 'type' in element) {
        ;(element as HTMLInputElement).type = type
      }
      const attr = options.attr
      if (attr) {
        Object.entries(attr).forEach(([key, val]) => {
          element.setAttribute(key, String(val))
        })
      }
      this.appendChild(element)
      return element
    }
  }

  private resolveScheduledTimeValue(task: RoutineTaskShape): string {
    if (typeof task.scheduledTime === 'string' && task.scheduledTime.length > 0) {
      return task.scheduledTime
    }
    const frontmatter = task.frontmatter as Record<string, unknown>
    const legacy = frontmatter?.['開始時刻']
    if (typeof legacy === 'string' && legacy.length > 0) {
      return legacy
    }
    return '09:00'
  }

  private normalizeRoutineType(value: unknown): RoutineKind {
    if (value === 'weekly' || value === 'monthly') {
      return value
    }
    return 'daily'
  }
}
