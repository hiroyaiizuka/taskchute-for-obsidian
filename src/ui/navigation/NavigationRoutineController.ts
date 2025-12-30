
import { App, Notice, TFile } from 'obsidian'
import { getScheduledTime, setScheduledTime } from '../../utils/fieldMigration'
import type { RoutineTaskShape } from '../../types/routine'
import NavigationRoutineRenderer, { RoutineTaskWithFile } from './NavigationRoutineRenderer'

export interface NavigationRoutineHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: App
  plugin: {
    pathManager: {
      getTaskFolderPath: () => string
    }
  }
  navigationContent?: HTMLElement
  reloadTasksAndRestore?: (options?: { runBoundaryCheck?: boolean }) => Promise<void> | void
  showRoutineEditModal?: (task: RoutineTaskShape, element?: HTMLElement) => void
  getWeekdayNames: () => string[]
}

export default class NavigationRoutineController {
  private readonly renderer: NavigationRoutineRenderer

  constructor(private readonly host: NavigationRoutineHost) {
    this.renderer = new NavigationRoutineRenderer(
      {
        tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
        getWeekdayNames: () => this.host.getWeekdayNames(),
      },
      {
        onToggle: async (task, enabled) => {
          await this.updateRoutineEnabled(task.file, enabled)
          await this.host.reloadTasksAndRestore?.({ runBoundaryCheck: true })
          task.routine_enabled = enabled
        },
        onEdit: (task, element) => {
          this.host.showRoutineEditModal?.(task, element)
        },
      },
    )
  }

  renderRoutineList(): void {
    const container = this.host.navigationContent
    if (!container) return
    container.empty()

    const header = container.createEl('div', { cls: 'routine-list-header' })
    header.createEl('h3', {
      text: this.host.tv('labels.routineList', 'Routine list'),
    })
    const hint = container.createEl('div', { cls: 'routine-list-hint' })
    hint.textContent = this.host.tv(
      'labels.routineToggleHelp',
      "Toggle routines on or off here. Edit details from each task's settings.",
    )

    const list = container.createEl('div', { cls: 'routine-list' })
    const taskFolderPath = this.host.plugin.pathManager.getTaskFolderPath()
    const files = this.host.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${taskFolderPath}/`))
      .map((file) => ({ file, task: this.normalizeRoutineTask(file) }))
      .filter((entry): entry is { file: TFile; task: RoutineTaskShape } => entry.task !== null)
      .sort((a, b) => a.file.basename.localeCompare(b.file.basename, 'ja'))

    files.forEach(({ file, task }) => {
      const taskWithFile: RoutineTaskWithFile = { ...task, file }
      const row = this.renderer.createRow(taskWithFile)
      list.appendChild(row)
    })

    if (files.length === 0) {
      const empty = container.createEl('div', { cls: 'routine-empty' })
      empty.textContent = this.host.tv('status.noRoutineFound', 'No routines found')
    }
  }

  private async updateRoutineEnabled(file: TFile, enabled: boolean): Promise<void> {
    await this.host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.routine_enabled = enabled
      return frontmatter
    })
    const noticeKey = enabled ? 'notices.routineEnabled' : 'notices.routineDisabled'
    new Notice(this.host.tv(noticeKey, enabled ? 'Routine enabled' : 'Routine disabled'))
  }

  async updateRoutineSchedule(file: TFile, scheduledTime: string): Promise<void> {
    await this.host.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      setScheduledTime(frontmatter, scheduledTime, { preferNew: true })
      return frontmatter
    })
    new Notice(this.host.tv('notices.routineScheduleUpdated', 'Routine schedule updated'))
  }

  private normalizeRoutineTask(file: TFile): RoutineTaskShape | null {
    const cache = this.host.app.metadataCache.getFileCache(file)
    const rawFrontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>
    if (rawFrontmatter.isRoutine !== true) {
      return null
    }

    const scheduledTime = getScheduledTime(rawFrontmatter) ?? undefined
    const name = typeof rawFrontmatter.name === 'string' ? rawFrontmatter.name : file.basename
    const displayTitle =
      typeof rawFrontmatter.displayTitle === 'string' && rawFrontmatter.displayTitle.trim().length > 0
        ? rawFrontmatter.displayTitle
        : name
    const title = typeof rawFrontmatter.title === 'string' ? rawFrontmatter.title : displayTitle

    const weekdays = Array.isArray(rawFrontmatter.weekdays)
      ? (rawFrontmatter.weekdays.filter((value): value is number => typeof value === 'number') ?? undefined)
      : undefined
    const routineWeekdaysArray = Array.isArray(rawFrontmatter.routine_weekdays)
      ? rawFrontmatter.routine_weekdays.filter((value): value is number => typeof value === 'number')
      : undefined
    const routineWeeksArray = Array.isArray(rawFrontmatter.routine_weeks)
      ? rawFrontmatter.routine_weeks.filter(
          (value): value is RoutineTaskShape['routine_week'] =>
            value === 'last' || typeof value === 'number',
        )
      : undefined
    const routineMonthdaysArray = Array.isArray(rawFrontmatter.routine_monthdays)
      ? rawFrontmatter.routine_monthdays.filter(
          (value): value is RoutineTaskShape['routine_monthday'] =>
            value === 'last' || typeof value === 'number',
        )
      : undefined
    const routineWeekday =
      typeof rawFrontmatter.routine_weekday === 'number'
        ? rawFrontmatter.routine_weekday
        : typeof rawFrontmatter.weekday === 'number'
          ? rawFrontmatter.weekday
          : undefined
    const routineWeek =
      rawFrontmatter.routine_week === 'last'
        ? 'last'
        : typeof rawFrontmatter.routine_week === 'number'
          ? rawFrontmatter.routine_week
          : undefined
    const routineMonthday =
      rawFrontmatter.routine_monthday === 'last'
        ? 'last'
        : typeof rawFrontmatter.routine_monthday === 'number'
          ? rawFrontmatter.routine_monthday
          : undefined

    const monthlyWeek =
      typeof rawFrontmatter.monthly_week === 'number' ? rawFrontmatter.monthly_week : undefined
    const monthlyWeekday =
      typeof rawFrontmatter.monthly_weekday === 'number' ? rawFrontmatter.monthly_weekday : undefined

    const routineType = typeof rawFrontmatter.routine_type === 'string'
      ? (rawFrontmatter.routine_type as RoutineTaskShape['routine_type'])
      : undefined

    const routineInterval =
      typeof rawFrontmatter.routine_interval === 'number' && rawFrontmatter.routine_interval > 0
        ? rawFrontmatter.routine_interval
        : undefined

    return {
      title,
      displayTitle,
      name,
      path: file.path,
      file,
      frontmatter: rawFrontmatter,
      isRoutine: true,
      scheduledTime,
      routine_type: routineType,
      routine_interval: routineInterval,
      routine_enabled: rawFrontmatter.routine_enabled !== false,
      weekdays,
      weekday: routineWeekday,
      monthly_week: monthlyWeek,
      monthly_weekday: monthlyWeekday,
      routine_week: routineWeek,
      routine_weekday: routineWeekday,
      routine_weeks: routineWeeksArray,
      routine_weekdays: routineWeekdaysArray,
      routine_monthday: routineMonthday,
      routine_monthdays: routineMonthdaysArray,
      projectPath: typeof rawFrontmatter.project_path === 'string' ? rawFrontmatter.project_path : undefined,
      projectTitle: typeof rawFrontmatter.project === 'string' ? rawFrontmatter.project : undefined,
    } as RoutineTaskShape
  }
}
