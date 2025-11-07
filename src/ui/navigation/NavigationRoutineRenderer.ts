import type { RoutineTaskShape } from '../../types/Routine'
import type { TFile } from 'obsidian'

export type RoutineTaskWithFile = RoutineTaskShape & { file: TFile }

export interface RoutineListHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getWeekdayNames: () => string[]
}

interface RoutineRowCallbacks {
  onToggle: (task: RoutineTaskWithFile, enabled: boolean) => Promise<void> | void
  onEdit: (task: RoutineTaskWithFile, element: HTMLElement) => void
}

export default class NavigationRoutineRenderer {
  constructor(private readonly host: RoutineListHost, private readonly callbacks: RoutineRowCallbacks) {}

  createRow(task: RoutineTaskWithFile): HTMLElement {
    const row = document.createElement('div')
    row.className = 'routine-row'

    row.appendChild(this.createTitle(task))
    const typeBadge = this.createTypeBadge(task)
    row.appendChild(typeBadge)
    row.appendChild(this.createToggle(task, typeBadge))
    row.appendChild(this.createEditButton(task))
    return row
  }

  private createTitle(task: RoutineTaskWithFile): HTMLElement {
    const title = document.createElement('div')
    title.className = 'routine-title'
    title.textContent = task.displayTitle ?? task.name
    return title
  }

  private createTypeBadge(task: RoutineTaskWithFile): HTMLElement {
    const badge = document.createElement('span')
    badge.className = 'routine-type-badge'
    badge.textContent = this.getRoutineTypeLabel(task)
    return badge
  }

  private createToggle(task: RoutineTaskWithFile, badge: HTMLElement): HTMLElement {
    const wrapper = document.createElement('label')
    wrapper.className = 'routine-enabled-toggle'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = task.routine_enabled !== false
    toggle.title = this.host.tv('tooltips.toggleRoutine', 'Toggle enabled state')
    toggle.addEventListener('change', async () => {
      await this.callbacks.onToggle(task, toggle.checked)
      badge.textContent = this.getRoutineTypeLabel(task)
    })
    wrapper.appendChild(toggle)
    return wrapper
  }

  private createEditButton(task: RoutineTaskWithFile): HTMLElement {
    const button = document.createElement('button')
    button.className = 'routine-edit-btn'
    button.textContent = this.host.tv('buttons.edit', 'Edit')
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.callbacks.onEdit(task, button)
    })
    return button
  }

  private getRoutineTypeLabel(task: RoutineTaskWithFile): string {
    const type = task.routine_type ?? 'daily'
    const interval = typeof task.routine_interval === 'number' && task.routine_interval > 0
      ? task.routine_interval
      : 1
    const dayNames = this.host.getWeekdayNames()

    switch (type) {
      case 'daily':
        return this.host.tv('labels.routineDailyLabel', 'Every {interval} day(s)', { interval })
      case 'weekly': {
        const weekdaySet = this.normalizeWeekdayArray(task.weekdays)
        if (weekdaySet.length > 0) {
          const joined =
            this.formatWeekdayList(weekdaySet) ?? this.host.tv('labels.routineDayUnset', 'No weekday set')
          return this.host.tv('labels.routineWeeklyLabel', 'Every {interval} week(s) on {day}', {
            interval,
            day: joined,
          })
        }
        const weekday = task.weekday ?? task.routine_weekday
        const dayLabel =
          typeof weekday === 'number'
            ? dayNames[weekday]
            : this.host.tv('labels.routineDayUnset', 'No weekday set')
        return this.host.tv('labels.routineWeeklyLabel', 'Every {interval} week(s) on {day}', {
          interval,
          day: dayLabel,
        })
      }
      case 'monthly': {
        const week = task.monthly_week ?? task.routine_week
        const weekLabel =
          week === 'last'
            ? this.host.tv('labels.routineWeekLast', 'Last')
            : this.host.tv('labels.routineWeekLabel', 'Week {week}', { week: Number(week ?? 0) + 1 })
        const weekday = task.monthly_weekday ?? task.routine_weekday
        const dayLabel =
          typeof weekday === 'number'
            ? dayNames[weekday]
            : this.host.tv('labels.routineDayUnset', 'No weekday set')
        return this.host.tv('labels.routineMonthlyLabel', 'Every {week} on {day}', {
          week: weekLabel,
          day: dayLabel,
        })
      }
      default:
        return this.host.tv('labels.routineDailyLabel', 'Every {interval} day(s)', { interval })
    }
  }

  private normalizeWeekdayArray(values?: number[]): number[] {
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

  private formatWeekdayList(weekdays: number[]): string | undefined {
    if (!weekdays.length) return undefined
    const names = this.host.getWeekdayNames()
    const labels = weekdays
      .map((value) => names[value])
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
    if (!labels.length) return undefined
    const joiner = this.host.tv('lists.weekdayJoiner', ' / ')
    return labels.join(joiner)
  }
}
