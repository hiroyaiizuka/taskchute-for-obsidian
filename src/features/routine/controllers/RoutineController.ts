import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import { t } from '../../../i18n'
import { DATE_FORMAT_DISPLAY } from '../../../constants'
import { applyRoutineFrontmatterMerge } from '../utils/RoutineFrontmatterUtils'
import { TaskValidator } from '../../core/services/TaskValidator'
import type { RoutineFrontmatter, TaskChutePluginLike, TaskData } from '../../../types'
import type { RoutineWeek } from '../../../types/TaskFields'
import type { RoutineTaskShape } from '../../../types/routine'
import { setScheduledTime } from '../../../utils/fieldMigration'
import { attachCalendarButtonIcon, attachCloseButtonIcon } from '../../../ui/components/iconUtils'
import {
  deriveRoutineModalTitle,
  deriveWeeklySelection,
  deriveMonthlySelection,
  deriveMonthlyDateSelection,
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
  monthly_monthday?: number | 'last'
  monthly_monthdays?: Array<number | 'last'>
  interval?: number
  enabled?: boolean
  start?: string
  end?: string
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
    const modalContent = modal.createEl('div', { cls: 'task-modal-content routine-edit-modal' })

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
    })
    attachCloseButtonIcon(closeButton)

    const form = modalContent.createEl('form', { cls: 'task-form' })

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
    })

    const options = [
      { value: 'daily', text: this.tv('forms.routineDaily', 'Daily') },
      { value: 'weekly', text: this.tv('forms.routineWeekly', 'Weekly (by weekday)') },
      { value: 'monthly', text: this.tv('forms.routineMonthly', 'Monthly (weekday)') },
      { value: 'monthly_date', text: this.tv('forms.routineMonthlyDate', 'Monthly (date)') },
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
      task.routine_type === 'weekly' || task.routine_type === 'monthly' || task.routine_type === 'monthly_date'
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
    })

    // Prevent touch events from immediately triggering the native time picker
    // when the modal opens (mobile touch event propagation issue)
    timeInput.disabled = true
    setTimeout(() => {
      timeInput.disabled = false
    }, 500)

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
    })

    const startDateGroup = form.createEl('div', { cls: 'form-group' })
    startDateGroup.createEl('label', {
      text: this.tv('forms.startDateLabel', 'Start date:'),
      cls: 'form-label',
    })
    const startInput = this.createDateInputWithIcon(
      startDateGroup,
      this.resolveRoutineStartValue(task),
      this.tv('forms.startDateLabel', 'Start date:'),
    )

    const endDateGroup = form.createEl('div', { cls: 'form-group' })
    endDateGroup.createEl('label', {
      text: this.tv('forms.endDateLabel', 'End date:'),
      cls: 'form-label',
    })
    const endInput = this.createDateInputWithIcon(
      endDateGroup,
      this.resolveRoutineEndValue(task),
      this.tv('forms.endDateLabel', 'End date:'),
    )

    const enabledGroup = form.createEl('div', { cls: 'form-group' })
    enabledGroup.createEl('label', {
      text: this.tv('forms.enabled', 'Enabled:'),
      cls: 'form-label',
    })
    const enabledToggle = enabledGroup.createEl('input', {
      type: 'checkbox',
    })
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

    const monthlyDateGroup = form.createEl('div', {
      cls: 'form-group routine-monthly-date-group',
    })
    monthlyDateGroup.classList.add('is-hidden')
    monthlyDateGroup.createEl('label', {
      text: this.tv('forms.selectMonthDays', 'Select dates:'),
      cls: 'form-label',
    })
    const monthdaySelect = monthlyDateGroup.createEl('div', {
      cls: 'routine-monthday-select',
    })
    const monthdayTrigger = monthdaySelect.createEl('button', {
      cls: 'form-input routine-monthday-trigger',
      attr: {
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    })
    const monthdayDropdown = monthdaySelect.createEl('div', {
      cls: 'routine-monthday-dropdown is-hidden',
    })
    const monthdayOptions = monthdayDropdown.createEl('div', {
      cls: 'routine-monthday-options',
    })
    const monthdayCheckboxes: HTMLInputElement[] = []
    for (let day = 1; day <= 31; day += 1) {
      const option = monthdayOptions.createEl('label', { cls: 'routine-monthday-option' })
      const checkbox = option.createEl('input', { type: 'checkbox', value: String(day) })
      option.createEl('span', {
        text: this.tv('labels.routineMonthdayNth', '{day}日', { day }),
        cls: 'routine-monthday-option__label',
      })
      monthdayCheckboxes.push(checkbox)
    }
    {
      const option = monthdayOptions.createEl('label', { cls: 'routine-monthday-option' })
      const checkbox = option.createEl('input', { type: 'checkbox', value: 'last' })
      option.createEl('span', {
        text: this.tv('labels.routineMonthdayLast', 'Last day'),
        cls: 'routine-monthday-option__label',
      })
      monthdayCheckboxes.push(checkbox)
    }

    const {
      monthday: initialMonthday,
      monthdaySet: initialMonthdaySet,
    } = deriveMonthlyDateSelection(task as TaskData)
    const normalizedMonthdaySet = initialMonthdaySet?.length
      ? initialMonthdaySet
      : initialMonthday !== undefined
        ? [initialMonthday]
        : []
    monthdayCheckboxes.forEach((checkbox) => {
      const match = checkbox.value === 'last'
        ? normalizedMonthdaySet.includes('last')
        : normalizedMonthdaySet.includes(Number(checkbox.value))
      checkbox.checked = match
    })
    const getSelectedMonthdays = () =>
      this.normalizeMonthdaySelection(
        monthdayCheckboxes
          .filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.value === 'last' ? 'last' : Number.parseInt(checkbox.value, 10)),
      )
    const updateMonthdayTrigger = () => {
      const selected = getSelectedMonthdays()
      const label =
        this.formatMonthdayList(selected) ?? this.tv('labels.routineMonthdayUnset', 'No date set')
      monthdayTrigger.textContent = label
      monthdayTrigger.classList.toggle('is-empty', selected.length === 0)
    }
    updateMonthdayTrigger()
    monthdayCheckboxes.forEach((checkbox) => {
      checkbox.addEventListener('change', updateMonthdayTrigger)
    })
    const openMonthdayDropdown = () => {
      monthdayDropdown.classList.remove('is-hidden')
      monthdayTrigger.setAttribute('aria-expanded', 'true')
    }
    const closeMonthdayDropdown = () => {
      monthdayDropdown.classList.add('is-hidden')
      monthdayTrigger.setAttribute('aria-expanded', 'false')
    }
    monthdayTrigger.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (monthdayDropdown.classList.contains('is-hidden')) {
        openMonthdayDropdown()
      } else {
        closeMonthdayDropdown()
      }
    })
    const handleMonthdayOutsideClick = (event: MouseEvent) => {
      if (!monthdaySelect.contains(event.target as Node)) {
        closeMonthdayDropdown()
      }
    }
    document.addEventListener('click', handleMonthdayOutsideClick)

    const syncVisibility = () => {
      const selectedType = typeSelect.value
      const isWeekly = selectedType === 'weekly'
      const isMonthly = selectedType === 'monthly'
      const isMonthlyDate = selectedType === 'monthly_date'
      weeklyGroup.classList.toggle('is-hidden', !isWeekly)
      monthlyLabel.classList.toggle('is-hidden', !isMonthly)
      monthlyGroup.classList.toggle('is-hidden', !isMonthly)
      monthlyDateGroup.classList.toggle('is-hidden', !isMonthlyDate)
      if (!isMonthlyDate) {
        closeMonthdayDropdown()
      }
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
      })
    }

    const closeModal = () => {
      document.removeEventListener('click', handleMonthdayOutsideClick)
      modal.remove()
    }
    closeButton.addEventListener('click', closeModal)
    cancelButton.addEventListener('click', closeModal)

    if (removeButton) {
      removeButton.addEventListener('click', (event) => {
        void (async () => {
          event.preventDefault()
          event.stopPropagation()
          await this.toggleRoutine(task, anchor ?? removeButton)
          closeModal()
        })()
      })
    }

    form.addEventListener('submit', (event) => {
      void (async () => {
      event.preventDefault()
      const scheduledTime = timeInput.value
      const routineType = this.normalizeRoutineType(typeSelect.value)
      const interval = Math.max(1, Number.parseInt(intervalInput.value || '1', 10) || 1)
      const enabled = enabledToggle.checked
      const start = (startInput.value || '').trim()
      const end = (endInput.value || '').trim()
      const isDate = (value: string) =>
        !value || /^\d{4}-\d{2}-\d{2}$/.test(value)
      if (!scheduledTime) {
        new Notice(this.tv('forms.scheduledTimePlaceholder', 'Enter a scheduled start time'))
        return
      }
      if (!isDate(start)) {
        new Notice(
          this.tv(
            'forms.startDateFormat',
            'Start date must use {format} format.',
            { format: DATE_FORMAT_DISPLAY },
          ),
        )
        return
      }
      if (!isDate(end)) {
        new Notice(
          this.tv(
            'forms.endDateFormat',
            'End date must use {format} format.',
            { format: DATE_FORMAT_DISPLAY },
          ),
        )
        return
      }
      if (start && end && start > end) {
        new Notice(
          this.tv(
            'forms.endBeforeStart',
            'End date must be on or after the start date.',
          ),
        )
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
      if (routineType === 'monthly_date') {
        const selectedDays = getSelectedMonthdays()
        if (selectedDays.length === 0) {
          new Notice(this.tv('forms.selectMonthDaysPrompt', 'Select at least one date'))
          return
        }
      }
      const detailPayload: RoutineDetailsInput = {
        interval,
        enabled,
        start,
        end,
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
          detailPayload.monthly_week = onlyWeek === 'last' ? 'last' : (onlyWeek) - 1
        } else {
          detailPayload.monthly_week = undefined
        }

        const pickedWeekdays = monthlyWeekdayCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => Number.parseInt(cb.value, 10))
        const normalizedWeekdays = this.normalizeWeekdaySelection(pickedWeekdays)
        detailPayload.monthly_weekdays = normalizedWeekdays
        detailPayload.monthly_weekday = normalizedWeekdays.length === 1 ? normalizedWeekdays[0] : undefined
      } else if (routineType === 'monthly_date') {
        const normalizedMonthdays = getSelectedMonthdays()
        detailPayload.monthly_monthdays = normalizedMonthdays
        detailPayload.monthly_monthday = normalizedMonthdays.length === 1 ? normalizedMonthdays[0] : undefined
      }

      await this.setRoutineTaskWithDetails(task, anchor ?? modalContent, scheduledTime, routineType, detailPayload)
      closeModal()
      })()
    })

    document.body.appendChild(modal)
    // Removed timeInput.focus() - prevents native time picker from auto-opening on mobile
  }

  async toggleRoutine(task: RoutineTaskShape, button?: HTMLElement): Promise<void> {
    try {
      if (task.isRoutine) {
        const file = this.resolveTaskFile(task)
        if (!file) {
          this.notifyFileMissing(task)
          return
        }
        await this.host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
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
        const changes: Record<string, unknown> = {
          isRoutine: true,
          routine_type: routineType,
          routine_enabled: details.enabled !== false,
          routine_interval: Math.max(1, details.interval || 1),
        }
        const hasStart = 'start' in details
        const hasEnd = 'end' in details
        const startValue = hasStart ? (details.start ?? '').trim() : undefined
        const endValue = hasEnd ? (details.end ?? '').trim() : undefined
        const fallbackStart = this.resolveRoutineStartValue(task)
        setScheduledTime(changes, scheduledTime, { preferNew: true })
        if (startValue) {
          changes.routine_start = startValue
        } else if (!hasStart && fallbackStart) {
          changes.routine_start = fallbackStart
        }
        if (endValue) {
          changes.routine_end = endValue
        }
        const routineFrontmatter = frontmatter as RoutineFrontmatter
        const cleaned = TaskValidator.cleanupOnRoutineChange(routineFrontmatter, changes)
        if (hasStart && !startValue) {
          delete cleaned.routine_start
        }
        if (hasEnd && !endValue) {
          delete cleaned.routine_end
        }
        delete cleaned.weekday
        delete cleaned.weekdays
        delete cleaned.monthly_week
        delete cleaned.monthly_weekday
        delete cleaned.routine_week
        delete cleaned.routine_weekday
        delete cleaned.routine_monthday
        delete cleaned.routine_monthdays
        applyRoutineFrontmatterMerge(routineFrontmatter, cleaned)
        const mergedStart = routineFrontmatter.routine_start
        const mergedEnd = routineFrontmatter.routine_end
        if (typeof mergedStart === 'string' && mergedStart.length > 0) {
          task.routine_start = mergedStart
        } else {
          delete task.routine_start
        }
        if (typeof mergedEnd === 'string' && mergedEnd.length > 0) {
          task.routine_end = mergedEnd
        } else {
          delete task.routine_end
        }
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
                      : (details.monthly_week) + 1,
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
          delete routineFrontmatter.routine_monthday
          delete routineFrontmatter.routine_monthdays
        } else if (routineType === 'monthly_date') {
          const normalizedMonthdays = this.normalizeMonthdaySelection(
            Array.isArray(details.monthly_monthdays) && details.monthly_monthdays.length
              ? details.monthly_monthdays
              : details.monthly_monthday !== undefined
                ? [details.monthly_monthday]
                : [],
          )
          if (normalizedMonthdays.length > 0) {
            routineFrontmatter.routine_monthdays = normalizedMonthdays
            if (normalizedMonthdays.length === 1) {
              routineFrontmatter.routine_monthday = normalizedMonthdays[0]
            } else {
              delete routineFrontmatter.routine_monthday
            }
          } else {
            delete routineFrontmatter.routine_monthdays
            delete routineFrontmatter.routine_monthday
          }
          delete routineFrontmatter.weekday
          delete routineFrontmatter.weekdays
          delete routineFrontmatter.monthly_week
          delete routineFrontmatter.monthly_weekday
          delete routineFrontmatter.routine_week
          delete routineFrontmatter.routine_weekday
          delete routineFrontmatter.routine_weeks
          delete routineFrontmatter.routine_weekdays
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

  private createDateInputWithIcon(
    container: HTMLElement,
    value: string,
    ariaLabel: string,
  ): HTMLInputElement {
    const wrapper = container.createEl('div', { cls: 'form-input-icon-wrapper' })
    const input = wrapper.createEl('input', {
      type: 'date',
      cls: 'form-input--date form-input--bare',
      value,
    })
    const button = wrapper.createEl('button', {
      type: 'button',
      cls: 'form-input-icon-button',
      attr: {
        'aria-label': ariaLabel,
        title: ariaLabel,
      },
    })
    attachCalendarButtonIcon(button)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.openDatePicker(input)
    })
    return input
  }

  private openDatePicker(input: HTMLInputElement): void {
    const picker = input as HTMLInputElement & { showPicker?: () => void }
    if (picker.showPicker) {
      picker.showPicker()
      return
    }
    input.focus()
    input.click()
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
    return 'Untitled task'
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
      delete task.routine_monthday
      delete task.routine_monthdays
    } else if (routineType === 'monthly') {
      const normalizedWeeks = this.normalizeWeekSelection(
        Array.isArray(details.monthly_weeks) && details.monthly_weeks.length
          ? details.monthly_weeks
          : details.monthly_week !== undefined
            ? [
                details.monthly_week === 'last'
                  ? 'last'
                  : (details.monthly_week) + 1,
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
      delete task.routine_monthday
      delete task.routine_monthdays
    } else if (routineType === 'monthly_date') {
      const normalizedMonthdays = this.normalizeMonthdaySelection(
        Array.isArray(details.monthly_monthdays) && details.monthly_monthdays.length
          ? details.monthly_monthdays
          : details.monthly_monthday !== undefined
            ? [details.monthly_monthday]
            : [],
      )
      task.routine_monthdays = normalizedMonthdays
      if (normalizedMonthdays.length === 1) {
        task.routine_monthday = normalizedMonthdays[0]
      } else {
        delete task.routine_monthday
      }
      delete task.weekday
      delete task.weekdays
      delete task.monthly_week
      delete task.monthly_weekday
      delete task.routine_week
      delete task.routine_weekday
      delete task.routine_weeks
      delete task.routine_weekdays
    } else {
      delete task.weekday
      delete task.weekdays
      delete task.monthly_week
      delete task.monthly_weekday
      delete task.routine_week
      delete task.routine_weekday
      delete task.routine_weeks
      delete task.routine_weekdays
      delete task.routine_monthday
      delete task.routine_monthdays
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
                      : (details.monthly_week) + 1,
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
      case 'monthly_date': {
        const monthdaySet = this.normalizeMonthdaySelection(
          Array.isArray(details.monthly_monthdays) && details.monthly_monthdays.length
            ? details.monthly_monthdays
            : Array.isArray(task.routine_monthdays) && task.routine_monthdays.length
              ? task.routine_monthdays
              : details.monthly_monthday !== undefined
                ? [details.monthly_monthday]
                : task.routine_monthday !== undefined
                  ? [task.routine_monthday]
                  : [],
        )
        const dayLabel =
          this.formatMonthdayList(monthdaySet) ?? this.tv('labels.routineMonthdayUnset', 'No date set')
        const monthlyLabel = this.tv('labels.routineMonthlyDateLabel', 'Every {interval} month(s) on {day}', {
          interval: intervalValue,
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

  private normalizeWeekSelection(values?: unknown[]): RoutineWeek[] {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    return values
      .map((value) => (value === 'last' ? 'last' : Number(value)))
      .filter((value): value is RoutineWeek => {
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

  private normalizeMonthdaySelection(values?: Array<number | 'last'>): Array<number | 'last'> {
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    const result: Array<number | 'last'> = []
    values.forEach((value) => {
      if (value === 'last') {
        if (!seen.has('last')) {
          seen.add('last')
          result.push('last')
        }
        return
      }
      const num = Number(value)
      if (Number.isInteger(num) && num >= 1 && num <= 31) {
        const key = String(num)
        if (!seen.has(key)) {
          seen.add(key)
          result.push(num)
        }
      }
    })
    return result.sort((a, b) => {
      if (a === 'last') return 1
      if (b === 'last') return -1
      return Number(a) - Number(b)
    })
  }

  private formatMonthdayList(monthdays?: Array<number | 'last'>): string | undefined {
    if (!Array.isArray(monthdays) || monthdays.length === 0) return undefined
    const joiner = this.tv('lists.weekdayJoiner', ' / ')
    const labels = monthdays.map((day) =>
      day === 'last'
        ? this.tv('labels.routineMonthdayLast', 'Last day')
        : this.tv('labels.routineMonthdayNth', '{day}日', { day }),
    )
    return labels.join(joiner)
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
      })
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
    const frontmatter = task.frontmatter
    const legacy = frontmatter?.['開始時刻']
    if (typeof legacy === 'string' && legacy.length > 0) {
      return legacy
    }
    return '09:00'
  }

  private resolveRoutineStartValue(task: RoutineTaskShape): string {
    const direct = this.normalizeDateString(task.routine_start)
    if (direct) return direct
    const fromFrontmatter = this.getFrontmatterDate(task, 'routine_start')
      ?? this.getFrontmatterDate(task, 'execution_date')
      ?? this.getFrontmatterDate(task, 'target_date')
    if (fromFrontmatter) return fromFrontmatter
    if (!task.isRoutine) {
      return this.formatCurrentDate()
    }
    return ''
  }

  private resolveRoutineEndValue(task: RoutineTaskShape): string {
    if (!task.isRoutine) {
      return ''
    }
    const direct = this.normalizeDateString(task.routine_end)
    if (direct) return direct
    return this.getFrontmatterDate(task, 'routine_end') ?? ''
  }

  private normalizeDateString(value: unknown): string | undefined {
    return this.isDateString(value) ? value : undefined
  }

  private getFrontmatterDate(task: RoutineTaskShape, key: string): string | undefined {
    const frontmatter = task.frontmatter
    if (!frontmatter || typeof frontmatter !== 'object') return undefined
    return this.normalizeDateString(frontmatter[key])
  }

  private isDateString(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  }

  private normalizeRoutineType(value: unknown): RoutineKind {
    if (value === 'weekly' || value === 'monthly' || value === 'monthly_date') {
      return value
    }
    return 'daily'
  }
}
