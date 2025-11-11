import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import { t } from '../../../i18n'
import { applyRoutineFrontmatterMerge } from '../utils/RoutineFrontmatterUtils'
import { TaskValidator } from '../../core/services/TaskValidator'
import type { RoutineFrontmatter, TaskChutePluginLike, TaskData } from '../../../types'
import type { RoutineWeek } from '../../../types/TaskFields'
import type { RoutineTaskShape } from '../../../types/Routine'
import { setScheduledTime } from '../../../utils/fieldMigration'
import { attachCloseButtonIcon } from '../../../ui/components/iconUtils'
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
  monthly_weeks?: Array<number | 'last'>
  monthly_weekdays?: number[]
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
    attachCloseButtonIcon(closeButton)

    const form = modalContent.createEl('form', { cls: 'task-form' }) as HTMLFormElement

    const preventInputEnterSubmit = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') {
        return
      }
      const target = event.target
      if (target instanceof HTMLButtonElement) {
        return
      }
      event.preventDefault()
    }
    form.addEventListener('keydown', preventInputEnterSubmit)
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
      cls: 'form-group routine-weekly-group routine-chip-panel',
    })
    weeklyGroup.classList.add('is-hidden')
    const weekdays = this.getWeekdayNames().map((label, value) => ({ value, label }))
    const weekdayCheckboxes = this.createChipFieldset(
      weeklyGroup,
      this.tv('forms.selectWeekdays', 'Select weekdays:'),
      weekdays.map((day) => ({ value: String(day.value), label: day.label })),
    )
    deriveWeeklySelection(task as TaskData).forEach((day) => {
      const checkbox = weekdayCheckboxes[day]
      if (checkbox) checkbox.checked = true
    })

    const monthlyLabel = form.createEl('label', {
      text: this.tv('forms.monthlySettings', 'Monthly settings:'),
      cls: 'form-label routine-monthly-group__heading',
    })
    monthlyLabel.classList.add('is-hidden')
    const monthlyGroup = form.createEl('div', {
      cls: 'form-group routine-monthly-group routine-chip-panel',
    })
    monthlyGroup.classList.add('is-hidden')

    const monthWeekCheckboxes = this.createChipFieldset(
      monthlyGroup,
      this.tv('forms.selectMonthWeeks', 'Select weeks:'),
      [...[1, 2, 3, 4, 5].map((week) => ({
        value: String(week),
        label: this.tv('labels.routineWeekNth', 'Week {week}', { week }),
      })),
      { value: 'last', label: this.tv('labels.routineWeekLast', 'Last week') }],
    )
    const monthlyWeekdayCheckboxes = this.createChipFieldset(
      monthlyGroup,
      this.tv('forms.selectMonthWeekdays', 'Select weekdays:'),
      weekdays.map((day) => ({ value: String(day.value), label: day.label })),
    )

    const {
      week: initialMonthWeek,
      weekday: initialMonthWeekday,
      weekSet: initialWeekSet,
      weekdaySet: initialMonthWeekdaySet,
    } = deriveMonthlySelection(task as TaskData)

    const normalizedWeekSet = initialWeekSet?.length
      ? initialWeekSet
      : initialMonthWeek !== undefined
        ? [initialMonthWeek]
        : []
    normalizedWeekSet.forEach((weekValue) => {
      monthWeekCheckboxes.forEach((checkbox) => {
        if (
          (weekValue === 'last' && checkbox.value === 'last') ||
          (typeof weekValue === 'number' && checkbox.value === String(weekValue))
        ) {
          checkbox.checked = true
        }
      })
    })

    const normalizedWeekdaySet = initialMonthWeekdaySet?.length
      ? initialMonthWeekdaySet
      : typeof initialMonthWeekday === 'number'
        ? [initialMonthWeekday]
        : []
    normalizedWeekdaySet.forEach((weekdayValue) => {
      const checkbox = monthlyWeekdayCheckboxes[weekdayValue]
      if (checkbox) {
        checkbox.checked = true
      }
    })

    const syncVisibility = () => {
      const selectedType = typeSelect.value
      const isWeekly = selectedType === 'weekly'
      const isMonthly = selectedType === 'monthly'
      weeklyGroup.classList.toggle('is-hidden', !isWeekly)
      monthlyLabel.classList.toggle('is-hidden', !isMonthly)
      monthlyGroup.classList.toggle('is-hidden', !isMonthly)
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
      if (routineType === 'monthly') {
        const selectedWeeks = monthWeekCheckboxes.filter((cb) => cb.checked)
        if (selectedWeeks.length === 0) {
          new Notice(this.tv('forms.selectMonthWeeksPrompt', 'Select at least one week'))
          return
        }
        const selectedWeekdays = monthlyWeekdayCheckboxes.filter((cb) => cb.checked)
        if (selectedWeekdays.length === 0) {
          new Notice(this.tv('forms.selectMonthWeekdaysPrompt', 'Select at least one weekday'))
          return
        }
      }
      const detailPayload: RoutineDetailsInput = {
        interval,
        enabled,
      }

      if (routineType === 'weekly') {
        const picked = weekdayCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => Number.parseInt(cb.value, 10))
          .filter((value) => Number.isInteger(value))
        detailPayload.weekdays = this.normalizeWeekdaySelection(picked)
      } else if (routineType === 'monthly') {
        const pickedWeeks = monthWeekCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => (cb.value === 'last' ? 'last' : Number.parseInt(cb.value, 10)))
        const normalizedWeeks = this.normalizeWeekSelection(pickedWeeks)
        detailPayload.monthly_weeks = normalizedWeeks
        if (normalizedWeeks.length === 1) {
          const onlyWeek = normalizedWeeks[0]
          detailPayload.monthly_week = onlyWeek === 'last' ? 'last' : (onlyWeek as number) - 1
        } else {
          detailPayload.monthly_week = undefined
        }

        const pickedWeekdays = monthlyWeekdayCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => Number.parseInt(cb.value, 10))
        const normalizedWeekdays = this.normalizeWeekdaySelection(pickedWeekdays)
        detailPayload.monthly_weekdays = normalizedWeekdays
        detailPayload.monthly_weekday = normalizedWeekdays.length === 1 ? normalizedWeekdays[0] : undefined
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
        if (routineType === 'weekly') {
          const weekdays = this.normalizeWeekdaySelection(details.weekdays)
          if (weekdays.length > 1) {
            routineFrontmatter.weekdays = weekdays
          } else {
            delete routineFrontmatter.weekdays
          }
          if (weekdays.length > 0) {
            routineFrontmatter.routine_weekday = weekdays[0]
          } else {
            delete routineFrontmatter.routine_weekday
          }
        } else if (routineType === 'monthly') {
          const normalizedWeeks = this.normalizeWeekSelection(
            Array.isArray(details.monthly_weeks) && details.monthly_weeks.length
              ? details.monthly_weeks
              : details.monthly_week !== undefined
                ? [
                    details.monthly_week === 'last'
                      ? 'last'
                      : (details.monthly_week as number) + 1,
                  ]
                : [],
          )
          if (normalizedWeeks.length > 0) {
            routineFrontmatter.routine_weeks = normalizedWeeks
            if (normalizedWeeks.length === 1) {
              routineFrontmatter.routine_week = normalizedWeeks[0]
            } else {
              delete routineFrontmatter.routine_week
            }
          } else {
            delete routineFrontmatter.routine_weeks
            delete routineFrontmatter.routine_week
          }

          const normalizedWeekdays = this.normalizeWeekdaySelection(
            Array.isArray(details.monthly_weekdays) && details.monthly_weekdays.length
              ? details.monthly_weekdays
              : typeof details.monthly_weekday === 'number'
                ? [details.monthly_weekday]
                : [],
          )
          if (normalizedWeekdays.length > 0) {
            routineFrontmatter.routine_weekdays = normalizedWeekdays
            if (normalizedWeekdays.length === 1) {
              routineFrontmatter.routine_weekday = normalizedWeekdays[0]
            } else {
              delete routineFrontmatter.routine_weekday
            }
          } else {
            delete routineFrontmatter.routine_weekdays
            delete routineFrontmatter.routine_weekday
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
      const selected = this.normalizeWeekdaySelection(details.weekdays)
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
      delete task.routine_weeks
      delete task.routine_weekdays
    } else if (routineType === 'monthly') {
      const normalizedWeeks = this.normalizeWeekSelection(
        Array.isArray(details.monthly_weeks) && details.monthly_weeks.length
          ? details.monthly_weeks
          : details.monthly_week !== undefined
            ? [
                details.monthly_week === 'last'
                  ? 'last'
                  : (details.monthly_week as number) + 1,
              ]
            : [],
      )
      task.routine_weeks = normalizedWeeks
      if (normalizedWeeks.length === 1) {
        const singleWeek = normalizedWeeks[0]
        if (singleWeek === 'last') {
          task.monthly_week = 'last'
          task.routine_week = 'last'
        } else if (typeof singleWeek === 'number') {
          task.monthly_week = (singleWeek - 1) as RoutineWeek
          task.routine_week = singleWeek
        }
      } else {
        delete task.monthly_week
        delete task.routine_week
      }

      const normalizedWeekdays = this.normalizeWeekdaySelection(
        Array.isArray(details.monthly_weekdays) && details.monthly_weekdays.length
          ? details.monthly_weekdays
          : typeof details.monthly_weekday === 'number'
            ? [details.monthly_weekday]
            : [],
      )
      task.routine_weekdays = normalizedWeekdays
      if (normalizedWeekdays.length === 1) {
        task.monthly_weekday = normalizedWeekdays[0]
        task.routine_weekday = normalizedWeekdays[0]
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
      delete task.routine_weeks
      delete task.routine_weekdays
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
        const weekdays = this.normalizeWeekdaySelection(details.weekdays?.length ? details.weekdays : task.weekdays)
        if (weekdays.length) {
          const dayList =
            this.formatWeekdayList(weekdays) ?? this.tv('labels.routineDayUnset', 'No weekday set')
          tooltip += ` - ${this.tv('labels.routineWeeklyLabel', 'Every {interval} week(s) on {day}', {
            interval: intervalValue,
            day: dayList,
          })}`
        }
        break
      }
      case 'monthly': {
        const weekSet = this.normalizeWeekSelection(
          Array.isArray(details.monthly_weeks) && details.monthly_weeks.length
            ? details.monthly_weeks
            : Array.isArray(task.routine_weeks) && task.routine_weeks.length
              ? task.routine_weeks
              : details.monthly_week !== undefined
                ? [
                    details.monthly_week === 'last'
                      ? 'last'
                      : (details.monthly_week as number) + 1,
                  ]
                : task.routine_week
                  ? [task.routine_week]
                  : [],
        )
        const weekdaySet = this.normalizeWeekdaySelection(
          Array.isArray(details.monthly_weekdays) && details.monthly_weekdays.length
            ? details.monthly_weekdays
            : Array.isArray(task.routine_weekdays) && task.routine_weekdays.length
              ? task.routine_weekdays
              : typeof details.monthly_weekday === 'number'
                ? [details.monthly_weekday]
                : typeof task.routine_weekday === 'number'
                  ? [task.routine_weekday]
                  : [],
        )
        const dayLabel =
          this.formatWeekdayList(weekdaySet) ?? this.tv('labels.routineDayUnset', 'No weekday set')
        const weekLabel = this.formatWeekList(weekSet) ??
          (weekSet.length === 1 && weekSet[0] === 'last'
            ? this.tv('labels.routineWeekLast', 'Last week')
            : this.tv('labels.routineWeekNth', 'Week {week}', { week: weekSet[0] ?? 1 }))
        const monthlyLabel = this.tv('labels.routineMonthlyLabel', 'Every {interval} month(s) on {week} {day}', {
          interval: intervalValue,
          week: weekLabel,
          day: dayLabel,
        })
        tooltip += ` - ${monthlyLabel.replace(/\s{2,}/g, ' ').trim()}`
        break
      }
      default:
        break
    }
    return tooltip
  }

  private normalizeWeekdaySelection(values?: number[]): number[] {
    if (!Array.isArray(values)) return []
    const seen = new Set<number>()
    return values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
      .filter((value) => {
        if (seen.has(value)) return false
        seen.add(value)
        return true
      })
      .sort((a, b) => a - b)
  }

  private formatWeekdayList(weekdays?: number[]): string | undefined {
    if (!Array.isArray(weekdays) || weekdays.length === 0) return undefined
    const names = this.getWeekdayNames()
    const labels = weekdays
      .map((index) => names[index])
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
    if (!labels.length) return undefined
    const joiner = this.tv('lists.weekdayJoiner', ' / ')
    return labels.join(joiner)
  }

  private normalizeWeekSelection(values?: Array<number | 'last'>): Array<number | 'last'> {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    return values
      .map((value) => (value === 'last' ? 'last' : Number(value)))
      .filter((value): value is number | 'last' => {
        if (value === 'last') return true
        return Number.isInteger(value) && value >= 1 && value <= 5
      })
      .filter((value) => {
        const key = String(value)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => {
        if (a === 'last') return 1
        if (b === 'last') return -1
        return (a as number) - (b as number)
      })
  }

  private formatWeekList(weeks?: Array<number | 'last'>): string | undefined {
    if (!Array.isArray(weeks) || weeks.length === 0) return undefined
    const joiner = this.tv('lists.weekLabelJoiner', ' / ')
    const labels = weeks.map((week) =>
      week === 'last'
        ? this.tv('labels.routineWeekLast', 'Last week')
        : this.tv('labels.routineWeekNth', 'Week {week}', { week }),
    )
    return labels.join(joiner)
  }

  private createChipFieldset(
    parent: HTMLElement,
    labelText: string,
    options: Array<{ value: string; label: string }>,
  ): HTMLInputElement[] {
    const fieldset = parent.createEl('div', { cls: 'routine-chip-fieldset' })
    fieldset.createEl('div', { cls: 'routine-chip-fieldset__label', text: labelText })
    const chipContainer = fieldset.createEl('div', { cls: 'routine-chip-fieldset__chips' })
    return options.map((option) => {
      const chip = chipContainer.createEl('label', { cls: 'routine-chip' })
      const checkbox = chip.createEl('input', {
        type: 'checkbox',
        value: option.value,
      }) as HTMLInputElement
      chip.createEl('span', { text: option.label, cls: 'routine-chip__text' })
      return checkbox
    })
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
