import { calculateNextBoundary } from '../../../utils/time'
import type { TaskInstance } from '../../../types'
import type { SectionConfigService } from '../../../services/SectionConfigService'

export type DayStateCacheClearMode = 'none' | 'current' | 'all'

interface TaskReloadCoordinatorHost {
  boundaryCheckTimeout: ReturnType<typeof setTimeout> | null
  currentDate: Date
  taskInstances: TaskInstance[]
  loadTasks: (options?: { clearDayStateCache?: DayStateCacheClearMode }) => Promise<void>
  restoreRunningTaskState: () => Promise<void>
  renderTaskList: () => void
  getTimeSlotKeys: () => string[]
  persistSlotAssignment: (inst: TaskInstance) => void
  sortTaskInstancesByTimeOrder: () => void
  saveTaskOrders: () => Promise<void>
  getCurrentDateString?: () => string
  getSectionConfig: () => SectionConfigService
}

interface ReloadOptions {
  runBoundaryCheck?: boolean
  clearDayStateCache?: DayStateCacheClearMode
}

export class TaskReloadCoordinator {
  constructor(private readonly view: TaskReloadCoordinatorHost) {}

  async reloadTasksAndRestore(options: ReloadOptions = {}): Promise<void> {
    await this.view.loadTasks({ clearDayStateCache: options.clearDayStateCache })
    await this.view.restoreRunningTaskState()
    this.view.renderTaskList()
    if (options.runBoundaryCheck) {
      await this.checkBoundaryTasks()
    }
    this.scheduleBoundaryCheck()
  }

  scheduleBoundaryCheck(): void {
    const { view } = this
    if (view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout)
    }
    const now = new Date()
    const boundaries = this.view.getSectionConfig().getTimeBoundaries()

    const next = calculateNextBoundary(now, boundaries)
    const delay = Math.max(0, next.getTime() - now.getTime() + 1000)

    view.boundaryCheckTimeout = setTimeout(() => {
      this.checkBoundaryTasks().catch((error) => {
        console.error('[TaskReloadCoordinator] boundary check failed', error)
      })
      this.scheduleBoundaryCheck()
    }, delay)
  }

  async checkBoundaryTasks(): Promise<void> {
    const { view } = this
    try {
      const todayKey = this.formatDateKey(new Date())
      const viewDateKey = view.getCurrentDateString
        ? view.getCurrentDateString()
        : this.formatDateKey(view.currentDate)
      if (viewDateKey !== todayKey) return

      const currentSlot = this.view.getSectionConfig().getCurrentTimeSlot(new Date())
      const slots = view.getTimeSlotKeys()
      const currentIndex = slots.indexOf(currentSlot)
      if (currentIndex < 0) return

      let moved = false
      view.taskInstances.forEach((inst) => {
        if (inst.state !== 'idle') return
        const slot = inst.slotKey || 'none'
        if (slot === 'none') return
        const idx = slots.indexOf(slot)
        if (idx >= 0 && idx < currentIndex) {
          inst.slotKey = currentSlot
          view.persistSlotAssignment(inst)
          moved = true
        }
      })

      if (moved) {
        view.sortTaskInstancesByTimeOrder()
        await view.saveTaskOrders()
        view.renderTaskList()
      }
    } catch (error) {
      console.error('[TaskReloadCoordinator] boundary move failed', error)
    }
  }

  private formatDateKey(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}
export default TaskReloadCoordinator
export type { TaskReloadCoordinatorHost }
