import 'obsidian'
import { calculateNextBoundary } from '@/utils/time'
import type { TaskInstance } from '@/types'
import type { SectionConfigService } from '@/services/SectionConfigService'

export type DayStateCacheClearMode = 'none' | 'current' | 'all'

interface TaskReloadCoordinatorHost {
  boundaryCheckTimeout: ReturnType<Window['setTimeout']> | null
  boundaryCheckWindow: Window | null
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
  queueIfInProgress?: boolean
}

export class TaskReloadCoordinator {
  private reloadPromise: Promise<void> | null = null
  private pendingOptions: ReloadOptions | null = null

  constructor(private readonly view: TaskReloadCoordinatorHost) {}

  async reloadTasksAndRestore(options: ReloadOptions = {}): Promise<void> {
    if (this.reloadPromise) {
      this.pendingOptions = this.mergeReloadOptions(this.pendingOptions, options)
      if (options.queueIfInProgress) {
        await this.reloadPromise
        return
      }
      await this.reloadPromise
      return
    }
    let resolveCycle!: () => void
    let rejectCycle!: (error: unknown) => void
    const cyclePromise = new Promise<void>((resolve, reject) => {
      resolveCycle = resolve
      rejectCycle = reject
    })
    this.reloadPromise = cyclePromise
    void this.runReloadCycle(options).then(
      () => resolveCycle(),
      (error) => rejectCycle(error),
    )
    try {
      await cyclePromise
    } finally {
      if (this.reloadPromise === cyclePromise) {
        this.reloadPromise = null
      }
    }
  }

  private async runReloadCycle(options: ReloadOptions): Promise<void> {
    let current: ReloadOptions | null = options
    while (current) {
      try {
        await this.executeReload(current)
      } catch (error) {
        this.pendingOptions = null
        throw error
      }
      current = this.pendingOptions
      this.pendingOptions = null
    }
  }

  private async executeReload(options: ReloadOptions): Promise<void> {
    await this.view.loadTasks({ clearDayStateCache: options.clearDayStateCache })
    await this.view.restoreRunningTaskState()
    this.view.renderTaskList()
    if (options.runBoundaryCheck) {
      await this.checkBoundaryTasks()
    }
    this.scheduleBoundaryCheck()
  }

  private mergeReloadOptions(
    existing: ReloadOptions | null,
    incoming: ReloadOptions,
  ): ReloadOptions {
    if (!existing) {
      return {
        runBoundaryCheck: incoming.runBoundaryCheck,
        clearDayStateCache: incoming.clearDayStateCache,
      }
    }
    const priority: Record<string, number> = { none: 0, current: 1, all: 2 }
    const a = existing.clearDayStateCache ?? 'current'
    const b = incoming.clearDayStateCache ?? 'current'
    return {
      runBoundaryCheck: existing.runBoundaryCheck || incoming.runBoundaryCheck,
      clearDayStateCache: (priority[a] ?? 0) >= (priority[b] ?? 0) ? a : b,
    }
  }

  scheduleBoundaryCheck(): void {
    const { view } = this
    if (view.boundaryCheckTimeout) {
      const timeout = view.boundaryCheckTimeout
      const timeoutWindow = view.boundaryCheckWindow ?? activeWindow
      view.boundaryCheckTimeout = null
      view.boundaryCheckWindow = null
      timeoutWindow.clearTimeout(timeout)
    }
    const now = new Date()
    const boundaries = this.view.getSectionConfig().getTimeBoundaries()

    const next = calculateNextBoundary(now, boundaries)
    const delay = Math.max(0, next.getTime() - now.getTime() + 1000)
    const timeoutWindow = activeWindow

    view.boundaryCheckWindow = timeoutWindow
    view.boundaryCheckTimeout = timeoutWindow.setTimeout(() => {
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

      const pastSlotIndex = (inst: TaskInstance): number => {
        if (inst.state !== 'idle') return -1
        const idx = slots.indexOf(inst.slotKey || 'none')
        return idx < currentIndex ? idx : -1
      }
      const carried = view.taskInstances.filter((inst) => pastSlotIndex(inst) >= 0)
      if (carried.length === 0) return

      // Orders are numbered per slot (100, 200, …), so carried tasks keep
      // numbers that collide with the current slot's own. Renumber them as one
      // block, in their earlier slot and order, above the current slot's idle
      // tasks: the day's order stays as it was planned (LEV-417).
      const orderOf = (inst: TaskInstance): number =>
        typeof inst.order === 'number' && Number.isFinite(inst.order) ? inst.order : Number.MAX_SAFE_INTEGER
      const block = carried
        .map((inst, position) => ({ inst, slot: pastSlotIndex(inst), position }))
        .sort((a, b) => a.slot - b.slot || orderOf(a.inst) - orderOf(b.inst) || a.position - b.position)
        .map(({ inst }) => inst)
      const peerOrders = view.taskInstances
        .filter((inst) => inst.state === 'idle' && (inst.slotKey || 'none') === currentSlot)
        .map(orderOf)
        .filter((order) => order !== Number.MAX_SAFE_INTEGER)
      const top = peerOrders.length > 0 ? Math.min(...peerOrders) : (block.length + 1) * 100
      block.forEach((inst, i) => {
        inst.slotKey = currentSlot
        inst.order = top - (block.length - i) * 100
        view.persistSlotAssignment(inst)
      })

      // Saved before sorting: the sort re-applies saved orders by task and
      // slot, and must find these rather than any older ones for this slot.
      await view.saveTaskOrders()
      view.sortTaskInstancesByTimeOrder()
      view.renderTaskList()
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
