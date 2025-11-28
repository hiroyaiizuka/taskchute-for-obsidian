import { Notice, TFile } from 'obsidian'
import TaskMoveCalendar, {
  TaskMoveCalendarFactory,
  TaskMoveCalendarHandle,
  TaskMoveCalendarOptions,
} from '../components/TaskMoveCalendar'
import type { TaskInstance, TaskData } from '../../types'

export interface TaskScheduleControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getInstanceDisplayTitle: (inst: TaskInstance) => string
  reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void>
  removeDuplicateInstanceFromCurrentDate?: (inst: TaskInstance) => Promise<void>
  /** Check if the instance is a duplicate (exists in dayState.duplicatedInstances) */
  isDuplicateInstance?: (inst: TaskInstance) => boolean
  /** Move a duplicate instance to a different date without modifying the original file */
  moveDuplicateInstanceToDate?: (inst: TaskInstance, dateStr: string) => Promise<void>
  app: {
    vault: {
      getAbstractFileByPath: (path: string) => unknown
    }
    fileManager: {
      processFrontMatter: (
        file: TFile,
        handler: (frontmatter: Record<string, unknown>) => void,
      ) => Promise<void>
    }
  }
  getCurrentDate: () => Date
  registerDisposer: (cleanup: () => void) => void
}

export interface TaskScheduleControllerDependencies {
  createCalendar: TaskMoveCalendarFactory
}

const defaultDependencies: TaskScheduleControllerDependencies = {
  createCalendar: (options: TaskMoveCalendarOptions) => new TaskMoveCalendar(options),
}

export default class TaskScheduleController {
  private activeMoveCalendar: TaskMoveCalendarHandle | null = null

  constructor(
    private readonly host: TaskScheduleControllerHost,
    private readonly dependencies: TaskScheduleControllerDependencies = defaultDependencies,
  ) {}

  showTaskMoveDatePicker(inst: TaskInstance, anchor: HTMLElement): void {
    if (this.activeMoveCalendar) {
      this.activeMoveCalendar.close()
      this.activeMoveCalendar = null
    }

    const current = this.host.getCurrentDate()
    const targetDate = inst.task?.frontmatter?.target_date
    const initialDate = this.parseTargetDate(targetDate, current)

    const calendar = this.dependencies.createCalendar({
      anchor,
      initialDate,
      today: new Date(),
      onSelect: async (isoDate) => {
        await this.moveTaskToDate(inst, isoDate)
      },
      onClose: () => {
        if (this.activeMoveCalendar === calendar) {
          this.activeMoveCalendar = null
        }
      },
      registerDisposer: (cleanup) => this.host.registerDisposer(cleanup),
    })

    this.activeMoveCalendar = calendar
    calendar.open()
  }

  async clearTaskTargetDate(inst: TaskInstance): Promise<void> {
    const displayTitle = this.host.getInstanceDisplayTitle(inst)
    const file = this.resolveTaskFile(inst.task)
    if (!(file instanceof TFile)) {
      return
    }

    try {
      await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (frontmatter.target_date) {
          delete frontmatter.target_date
        }
        return frontmatter
      })
      new Notice(
        this.host.tv('notices.taskMoveCleared', 'Cleared destination for "{title}"', {
          title: displayTitle,
        }),
      )
      await this.host.reloadTasksAndRestore()
    } catch (error) {
      console.error('[TaskScheduleController] Failed to clear target date', error)
      new Notice(
        this.host.tv('notices.taskMoveClearFailed', 'Failed to clear task destination'),
      )
    }
  }

  async moveTaskToDate(inst: TaskInstance, dateStr: string): Promise<void> {
    try {
      // Check if this is a duplicate instance
      const isDuplicate = this.host.isDuplicateInstance?.(inst) ?? false

      if (isDuplicate && this.host.moveDuplicateInstanceToDate) {
        // For duplicate instances, move via dayState without modifying the original file
        if (this.host.removeDuplicateInstanceFromCurrentDate) {
          await this.host.removeDuplicateInstanceFromCurrentDate(inst)
        }
        await this.host.moveDuplicateInstanceToDate(inst, dateStr)
      } else {
        // For non-duplicate instances, modify the file's frontmatter (original behavior)
        const file = this.resolveTaskFile(inst.task)
        if (file instanceof TFile) {
          await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter.target_date = dateStr
            return frontmatter
          })
        }
        if (this.host.removeDuplicateInstanceFromCurrentDate) {
          await this.host.removeDuplicateInstanceFromCurrentDate(inst)
        }
      }

      new Notice(
        this.host.tv('notices.taskMoveSuccess', 'Moved task to {date}', {
          date: dateStr,
        }),
      )
      await this.host.reloadTasksAndRestore()
    } catch (error) {
      console.error('[TaskScheduleController] Failed to move task', error)
      new Notice(this.host.tv('notices.taskMoveFailed', 'Failed to move task'))
    }
  }

  closeActiveCalendar(): void {
    if (this.activeMoveCalendar) {
      this.activeMoveCalendar.close()
      this.activeMoveCalendar = null
    }
  }

  private resolveTaskFile(task: TaskData): TFile | null {
    if (!task?.path) return null
    const abstract = this.host.app.vault.getAbstractFileByPath(task.path)
    return abstract instanceof TFile ? abstract : null
  }

  private parseTargetDate(targetDate: unknown, fallback: Date): Date {
    if (typeof targetDate === 'string') {
      const match = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
      if (match) {
        const [, y, m, d] = match
        const parsed = Date.parse(`${y}-${m}-${d}T00:00:00`)
        if (!Number.isNaN(parsed)) {
          return new Date(parsed)
        }
      }
    }
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate())
  }
}
