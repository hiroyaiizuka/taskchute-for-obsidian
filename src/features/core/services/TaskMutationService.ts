import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import {
  TaskInstance,
  TaskData,
  HiddenRoutine,
  DeletedInstance,
  SlotOverrideEntry,
} from '../../../types'
import type DayStateStoreService from '../../../services/DayStateStoreService'
import { isHidden as isHiddenEntry } from '../../../services/dayState/conflictResolver'
import type { SectionConfigService } from '../../../services/SectionConfigService'

type HiddenRoutineEntry = HiddenRoutine | string

type DuplicatedEntry = {
  instanceId?: string
  originalPath?: string
  slotKey?: string
  originalSlotKey?: string
  timestamp?: number
  createdMillis?: number
  originalTaskId?: string
  scheduledTime?: string | null
  reminderTime?: string | null
}

export interface DuplicateInstanceOptions {
  returnInstance?: boolean
  slotKey?: string
  scheduledTime?: string | null
  reminderTime?: string | null
  /** Internal event materialization should not announce a user duplication. */
  suppressNotice?: boolean
}

interface MutationDayState {
  hiddenRoutines: HiddenRoutineEntry[]
  deletedInstances: DeletedInstance[]
  duplicatedInstances: DuplicatedEntry[]
  slotOverrides: Record<string, string>
  slotOverridesMeta?: Record<string, SlotOverrideEntry>
  orders?: Record<string, number>
  ordersMeta?: Record<string, unknown>
}

export interface TaskMutationHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: Pick<App, 'vault' | 'fileManager'>
  plugin: {
    settings: { slotKeys?: Record<string, string> }
    saveSettings: () => Promise<void>
    pathManager: {
      getLogDataPath: () => string
      ensureFolderExists: (path: string) => Promise<void>
    }
  }
  taskInstances: TaskInstance[]
  tasks: TaskData[]
  renderTaskList: () => void
  generateInstanceId: (task: TaskData, dateKey: string) => string
  getInstanceDisplayTitle: (inst: TaskInstance) => string
  ensureDayStateForCurrentDate: () => Promise<unknown>
  getCurrentDayState: () => MutationDayState
  persistDayState: (dateKey: string) => Promise<void>
  getCurrentDateString: () => string
  calculateSimpleOrder: (index: number, tasks: TaskInstance[]) => number
  normalizeState: (state: TaskInstance['state']) => 'idle' | 'running' | 'done'
  saveTaskOrders: () => Promise<void>
  sortTaskInstancesByTimeOrder: () => void
  getOrderKey: (inst: TaskInstance) => string | null
  dayStateManager: DayStateStoreService
  removeRunningTaskRecord?: (params: { instanceId?: string; taskPath?: string; taskId?: string }) => Promise<unknown>
  removeTaskLogForInstanceOnDate?: (
    instanceId: string,
    dateKey: string,
    taskId?: string,
    taskPath?: string,
  ) => Promise<void>
  getSectionConfig: () => SectionConfigService
}

export default class TaskMutationService {
  private readonly duplicateRollbackContext = new WeakMap<
    TaskInstance,
    { dateKey: string; dayState: MutationDayState }
  >()

  constructor(private readonly host: TaskMutationHost) {}

  async duplicateInstance(
    inst: TaskInstance,
    options: DuplicateInstanceOptions = {},
  ): Promise<TaskInstance | void> {
    let materialized:
      | {
          instance: TaskInstance
          dateKey: string
          dayState: MutationDayState
        }
      | undefined
    try {
      await this.host.ensureDayStateForCurrentDate()
      const dateKey = this.host.getCurrentDateString()
      const dayState = this.host.getCurrentDayState()
      const sourceDuplicateEntry = this.findDuplicateEntry(dayState, inst)
      const resolvedOptions = this.resolveDuplicateScheduleOptions(options, sourceDuplicateEntry)
      const createdMillis = Date.now()
      const slotKey = this.resolveDuplicateSlotKey(inst, options, sourceDuplicateEntry)
      const originalSlotKey = inst.slotKey ?? sourceDuplicateEntry?.slotKey ?? slotKey
      const task = this.buildDuplicateTask(inst.task, resolvedOptions)
      const newInstance: TaskInstance = {
        task,
        instanceId: this.host.generateInstanceId(task, dateKey),
        date: dateKey,
        state: 'idle',
        slotKey,
        originalSlotKey,
        createdMillis,
        isDuplicate: true,
      }

      this.assignDuplicateOrder(newInstance, inst)
      this.host.taskInstances.push(newInstance)
      materialized = { instance: newInstance, dateKey, dayState }
      this.duplicateRollbackContext.set(newInstance, { dateKey, dayState })

      if (!dayState.duplicatedInstances.some((dup) => dup.instanceId === newInstance.instanceId)) {
        dayState.duplicatedInstances.push({
          instanceId: newInstance.instanceId,
          originalPath: sourceDuplicateEntry?.originalPath ?? inst.task.path,
          slotKey: newInstance.slotKey,
          originalSlotKey,
          timestamp: createdMillis,
          createdMillis,
          originalTaskId: sourceDuplicateEntry?.originalTaskId ?? inst.task.taskId,
          ...(resolvedOptions.scheduledTime !== undefined ? { scheduledTime: resolvedOptions.scheduledTime } : {}),
          ...(resolvedOptions.reminderTime !== undefined ? { reminderTime: resolvedOptions.reminderTime } : {}),
        })
        await this.host.persistDayState(dateKey)
      }

      this.safeRenderTaskList()
      if (!options.suppressNotice) {
        new Notice(
          this.host.tv('notices.taskDuplicated', 'Duplicated "{title}"', {
            title: this.host.getInstanceDisplayTitle(inst),
          }),
        )
      }

      if (options.returnInstance) {
        return newInstance
      }
    } catch (error) {
      if (materialized) {
        await this.rollbackDuplicateMaterialization(
          materialized.instance,
          materialized.dateKey,
          materialized.dayState,
        )
      }
      console.error('[TaskMutationService] duplicateInstance failed', error)
      new Notice(this.host.tv('notices.taskDuplicateFailed', 'Failed to duplicate task'))
    }
    return undefined
  }

  /**
   * Remove an internal duplicate that was created only to execute an event.
   *
   * Linked non-due routines are materialized before their timer starts. When
   * that later start is refused/failed, keeping the duplicate would expose a
   * task that the user never actually started. Roll back every in-memory
   * collection first, then best-effort persist the corrected day state.
   */
  async rollbackDuplicateInstance(inst: TaskInstance): Promise<void> {
    const context = this.duplicateRollbackContext.get(inst)
    const dateKey =
      context?.dateKey ??
      inst.date ??
      this.extractDateKeyFromInstanceId(inst.instanceId) ??
      this.host.getCurrentDateString()
    const store = this.host.dayStateManager as DayStateStoreService & {
      mutateSnapshot?: (
        key: string,
        mutator: (state: MutationDayState) => void,
      ) => Promise<unknown>
    }
    try {
      if (typeof store.mutateSnapshot === 'function') {
        this.removeDuplicateFromMemory(inst, undefined)
        await this.cleanupDuplicateRunningRecord(inst)
        await store.mutateSnapshot(dateKey, (dayState) => {
          this.removeDuplicateMetadataFromDayState(inst, dayState)
        })
        // A view reload can rematerialize the duplicate while the running
        // record or persisted snapshot is being cleaned. Sweep the live arrays
        // again after the final await so the just-removed metadata cannot
        // leave a visible ghost until the next reload.
        this.removeDuplicateFromMemory(inst, undefined)
        this.safeRenderTaskList()
        return
      }

      // Compatibility fallback for lightweight hosts/tests. Production uses
      // mutateSnapshot so navigation/cache replacement cannot race cleanup.
      const dayState =
        context?.dayState ??
        (dateKey === this.host.getCurrentDateString()
          ? this.host.getCurrentDayState()
          : undefined)
      if (!dayState) throw new Error(`Missing day state for duplicate rollback: ${dateKey}`)
      await this.rollbackDuplicateMaterialization(inst, dateKey, dayState)
    } catch (error) {
      this.removeDuplicateFromMemory(inst, context?.dayState)
      this.safeRenderTaskList()
      console.warn('[TaskMutationService] rollbackDuplicateInstance failed', error)
    } finally {
      this.duplicateRollbackContext.delete(inst)
    }
  }

  private async rollbackDuplicateMaterialization(
    inst: TaskInstance,
    dateKey: string,
    dayState: MutationDayState,
  ): Promise<void> {
    this.removeDuplicateFromMemory(inst, dayState)
    await this.cleanupDuplicateRunningRecord(inst)

    try {
      await this.host.persistDayState(dateKey)
    } catch (error) {
      // A failed materialization persist may have written partially. Retry the
      // corrected snapshot, but keep the in-memory rollback even if storage is
      // still unavailable.
      console.warn('[TaskMutationService] duplicate rollback persist failed', error)
    } finally {
      this.duplicateRollbackContext.delete(inst)
      this.safeRenderTaskList()
    }
  }

  private async cleanupDuplicateRunningRecord(inst: TaskInstance): Promise<void> {
    if (typeof this.host.removeRunningTaskRecord !== 'function') return
    try {
      await this.host.removeRunningTaskRecord({
        instanceId: inst.instanceId,
        taskPath: inst.task?.path,
        taskId: inst.task?.taskId,
      })
    } catch (error) {
      console.warn(
        '[TaskMutationService] duplicate rollback running-state cleanup failed',
        error,
      )
    }
  }

  private removeDuplicateFromMemory(
    inst: TaskInstance,
    dayState: MutationDayState | undefined,
  ): void {
    const instanceId = inst.instanceId
    this.host.taskInstances = this.host.taskInstances.filter(
      (candidate) =>
        candidate !== inst &&
        (!instanceId || candidate.instanceId !== instanceId),
    )

    const hasRemainingTaskInstance = this.host.taskInstances.some(
      (candidate) =>
        candidate.task === inst.task ||
        (Boolean(inst.task?.path) && candidate.task?.path === inst.task.path),
    )
    if (!hasRemainingTaskInstance) {
      this.host.tasks = this.host.tasks.filter(
        (task) =>
          task !== inst.task &&
          (!inst.task?.path || task.path !== inst.task.path),
      )
    }

    if (!dayState || !instanceId) return
    this.removeDuplicateMetadataFromDayState(inst, dayState)
  }

  private removeDuplicateMetadataFromDayState(
    inst: TaskInstance,
    dayState: MutationDayState,
  ): void {
    const instanceId = inst.instanceId
    if (!instanceId) return
    dayState.duplicatedInstances = dayState.duplicatedInstances.filter(
      (entry) => entry.instanceId !== instanceId,
    )
    const duplicateOrderKey = `${instanceId}::${inst.slotKey ?? 'none'}`
    if (dayState.orders) delete dayState.orders[duplicateOrderKey]
    if (dayState.ordersMeta) delete dayState.ordersMeta[duplicateOrderKey]
  }

  private resolveDuplicateSlotKey(
    inst: TaskInstance,
    options: DuplicateInstanceOptions,
    sourceEntry?: DuplicatedEntry,
  ): string {
    if (options.slotKey !== undefined) {
      return options.slotKey
    }

    if (typeof options.scheduledTime === 'string') {
      return this.host.getSectionConfig().calculateSlotKeyFromTime(options.scheduledTime)
        ?? inst.slotKey
        ?? sourceEntry?.slotKey
        ?? 'none'
    }

    return inst.slotKey ?? sourceEntry?.slotKey ?? 'none'
  }

  private findDuplicateEntry(
    dayState: MutationDayState,
    inst: TaskInstance,
  ): DuplicatedEntry | undefined {
    if (!inst.instanceId || !Array.isArray(dayState.duplicatedInstances)) {
      return undefined
    }
    return dayState.duplicatedInstances.find((entry) => entry.instanceId === inst.instanceId)
  }

  private resolveDuplicateScheduleOptions(
    options: DuplicateInstanceOptions,
    sourceEntry?: DuplicatedEntry,
  ): DuplicateInstanceOptions {
    if (!sourceEntry) {
      return options
    }

    return {
      ...options,
      scheduledTime: options.scheduledTime !== undefined
        ? options.scheduledTime
        : sourceEntry.scheduledTime,
      reminderTime: options.reminderTime !== undefined
        ? options.reminderTime
        : sourceEntry.reminderTime,
    }
  }

  private buildDuplicateTask(task: TaskData, options: DuplicateInstanceOptions): TaskData {
    const hasScheduleOverride =
      options.scheduledTime !== undefined || options.reminderTime !== undefined
    if (!hasScheduleOverride) {
      return task
    }

    const frontmatter = {
      ...(task.frontmatter ?? {}),
    }
    const cloned: TaskData = {
      ...task,
      frontmatter,
    }

    if (options.scheduledTime !== undefined) {
      if (options.scheduledTime === null) {
        delete cloned.scheduledTime
        delete frontmatter.scheduled_time
      } else {
        cloned.scheduledTime = options.scheduledTime
        frontmatter.scheduled_time = options.scheduledTime
      }
      delete frontmatter['開始時刻']
    }

    if (options.reminderTime !== undefined) {
      if (options.reminderTime === null) {
        delete cloned.reminder_time
        delete frontmatter.reminder_time
      } else {
        cloned.reminder_time = options.reminderTime
        frontmatter.reminder_time = options.reminderTime
      }
    }

    return cloned
  }

  async deleteTask(inst: TaskInstance): Promise<boolean> {
    if (!inst) return false
    try {
      return inst.task.isRoutine
        ? await this.deleteRoutineTask(inst)
        : await this.deleteNonRoutineTask(inst)
    } catch (error) {
      console.error('[TaskMutationService] deleteTask failed', error)
      new Notice(this.host.tv('notices.taskDeleteFailed', 'Failed to delete task'))
      return false
    }
  }

  async deleteInstance(inst: TaskInstance): Promise<boolean> {
    let removedIndex = -1
    let rollbackDateKey: string | undefined
    let rollbackDayState: MutationDayState | undefined
    let previousDeletedEntries: DeletedInstance[] | undefined
    let previousDuplicatedInstances: DuplicatedEntry[] | undefined
    try {
      await this.host.ensureDayStateForCurrentDate()
      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      const taskId = inst.task.taskId
      const hadSiblingWithSamePath = this.host.taskInstances.some(
        (candidate) => candidate !== inst && candidate.task?.path === inst.task.path,
      )
      removedIndex = this.host.taskInstances.indexOf(inst)
      if (removedIndex > -1) {
        this.host.taskInstances.splice(removedIndex, 1)
      }

      const dateKey = this.host.getCurrentDateString()
      const dayState = this.host.getCurrentDayState()
      const deletedEntries = [...this.host.dayStateManager.getDeleted(dateKey)]
      rollbackDateKey = dateKey
      rollbackDayState = dayState
      previousDeletedEntries = [...deletedEntries]
      previousDuplicatedInstances = [...dayState.duplicatedInstances]
      let isDuplicate = this.isDuplicatedTask(inst)
      const inferredDuplicate =
        !isDuplicate && !inst.task.isRoutine && hadSiblingWithSamePath

      if (inferredDuplicate) {
        isDuplicate = true
        console.warn(
          '[TaskMutationService] deleteInstance fallback duplicate metadata missing',
          {
            path: inst.task.path,
            instanceId: inst.instanceId,
          },
        )
      }
      const timestamp = Date.now()

      const wasDuplicate = isDuplicate

      if (isDuplicate) {
        deletedEntries.push({
          instanceId: inst.instanceId,
          path: inst.task.path,
          deletionType: 'temporary',
          timestamp,
          deletedAt: timestamp,
          taskId,
        })
        const hasExactDuplicateRecord = dayState.duplicatedInstances.some(
          (entry) => entry.instanceId === inst.instanceId,
        )
        dayState.duplicatedInstances = dayState.duplicatedInstances.filter(
          (entry) =>
            hasExactDuplicateRecord
              ? entry.instanceId !== inst.instanceId
              : entry.originalPath !== inst.task.path,
        )
      } else if (!inst.task.isRoutine) {
        const hasValidPath = typeof inst.task.path === 'string' && inst.task.path.length > 0
        if (hasValidPath) {
          deletedEntries.push({
            path: inst.task.path,
            deletionType: 'permanent',
            timestamp,
            deletedAt: timestamp,
            taskId,
          })
        } else {
          deletedEntries.push({
            instanceId: inst.instanceId,
            path: inst.task.path,
            deletionType: 'temporary',
            timestamp,
            deletedAt: timestamp,
            taskId,
          })
        }
      } else {
        deletedEntries.push({
          instanceId: inst.instanceId,
          path: inst.task.path,
          deletionType: 'temporary',
          timestamp,
          deletedAt: timestamp,
          taskId,
        })
      }

      this.host.dayStateManager.setDeleted(deletedEntries, dateKey)
      await this.host.persistDayState(dateKey)

      if (typeof this.host.removeRunningTaskRecord === 'function') {
        try {
          await this.host.removeRunningTaskRecord({
            instanceId: inst.instanceId,
          })
        } catch (error) {
          console.warn('[TaskMutationService] delete running-state cleanup failed', error)
        }
      }

      if (!inst.task.isRoutine) {
        if (!wasDuplicate) {
          void this.handleTaskFileDeletion(inst)
        } else {
          new Notice(
            this.host.tv('notices.taskRemovedFromToday', 'Removed task from the list.'),
          )
        }
      } else {
        new Notice(
          this.host.tv(
            'notices.taskRemovedFromTodayWithTitle',
            'Removed "{title}" from the list.',
            { title: displayTitle },
          ),
        )
      }

      this.safeRenderTaskList()
      return true
    } catch (error) {
      if (
        removedIndex >= 0 &&
        !this.host.taskInstances.includes(inst)
      ) {
        this.host.taskInstances.splice(
          Math.min(removedIndex, this.host.taskInstances.length),
          0,
          inst,
        )
      }
      if (
        rollbackDateKey &&
        rollbackDayState &&
        previousDeletedEntries &&
        previousDuplicatedInstances
      ) {
        rollbackDayState.duplicatedInstances = previousDuplicatedInstances
        this.host.dayStateManager.setDeleted(
          previousDeletedEntries,
          rollbackDateKey,
        )
        try {
          await this.host.persistDayState(rollbackDateKey)
        } catch (rollbackError) {
          console.warn(
            '[TaskMutationService] delete rollback persist failed',
            rollbackError,
          )
        }
      }
      this.safeRenderTaskList()
      console.error('[TaskMutationService] deleteInstance failed', error)
      new Notice(this.host.tv('notices.taskDeleteFailed', 'Failed to delete task'))
      return false
    }
  }

  async deleteTaskLogsByInstanceId(taskPath: string, instanceId: string): Promise<number> {
    try {
      if (!instanceId) {
        return 0
      }

      if (typeof this.host.removeTaskLogForInstanceOnDate !== 'function') {
        return 0
      }

      const dateKey = this.extractDateKeyFromInstanceId(instanceId) ?? this.host.getCurrentDateString()
      await this.host.removeTaskLogForInstanceOnDate(instanceId, dateKey, undefined, taskPath)
      return 1
    } catch (error) {
      console.warn('[TaskMutationService] deleteTaskLogsByInstanceId failed', error)
      return 0
    }
  }

  persistSlotAssignment(inst: TaskInstance): void {
    const dayState = this.host.getCurrentDayState()
    const taskPath = inst.task.path
    const taskId = typeof inst.task.taskId === 'string' ? inst.task.taskId : undefined
    const slotKeyValue = inst.slotKey || 'none'
    const scheduledTime = this.getScheduledTime(inst.task)
    let shouldPersistDayState = false

    const overrideKey = taskId ?? taskPath

    if (overrideKey) {
      if (inst.task.isRoutine) {
        const defaultSlot = scheduledTime ? this.host.getSectionConfig().getSlotFromTime(scheduledTime) : 'none'
        if (slotKeyValue === defaultSlot) {
          delete dayState.slotOverrides[overrideKey]
          if (taskId && taskPath && overrideKey !== taskPath) {
            delete dayState.slotOverrides[taskPath]
          }
          if (!dayState.slotOverridesMeta) {
            dayState.slotOverridesMeta = {}
          }
          const updatedAt = Date.now()
          dayState.slotOverridesMeta[overrideKey] = { slotKey: defaultSlot, updatedAt }
          if (taskId && taskPath && overrideKey !== taskPath) {
            dayState.slotOverridesMeta[taskPath] = { slotKey: defaultSlot, updatedAt }
          }
        } else {
          dayState.slotOverrides[overrideKey] = slotKeyValue
          if (taskId && taskPath && overrideKey !== taskPath) {
            delete dayState.slotOverrides[taskPath]
          }
          if (!dayState.slotOverridesMeta) {
            dayState.slotOverridesMeta = {}
          }
          dayState.slotOverridesMeta[overrideKey] = {
            slotKey: slotKeyValue,
            updatedAt: Date.now(),
          }
          if (taskId && taskPath && overrideKey !== taskPath) {
            delete dayState.slotOverridesMeta[taskPath]
          }
        }
      } else {
        dayState.slotOverrides[overrideKey] = slotKeyValue
        if (taskId && taskPath && overrideKey !== taskPath) {
          delete dayState.slotOverrides[taskPath]
        }
        if (!dayState.slotOverridesMeta) {
          dayState.slotOverridesMeta = {}
        }
        dayState.slotOverridesMeta[overrideKey] = {
          slotKey: slotKeyValue,
          updatedAt: Date.now(),
        }
        if (taskId && taskPath && overrideKey !== taskPath) {
          delete dayState.slotOverridesMeta[taskPath]
        }
        shouldPersistDayState = true
      }
    }

    if (shouldPersistDayState) {
      const dateKey = this.host.getCurrentDateString()
      void this.host.persistDayState(dateKey).catch((error) => {
        console.warn('[TaskMutationService] persistSlotAssignment persistDayState failed', error)
      })
    }

    if (inst.instanceId) {
      const key = this.host.getOrderKey(inst)
      if (key && dayState.orders && dayState.orders[key] != null) {
        // Keep existing order entry when present
      }
      const duplicateEntry = dayState.duplicatedInstances.find((entry) => entry.instanceId === inst.instanceId)
      if (duplicateEntry) {
        duplicateEntry.slotKey = inst.slotKey
      }
    }
  }

  isDuplicatedTask(inst: TaskInstance): boolean {
    const dayState = this.host.getCurrentDayState()
    return dayState.duplicatedInstances.some((entry) => entry.instanceId === inst.instanceId)
  }

  async syncDuplicateSlotWithScheduledTime(
    inst: TaskInstance,
    params: { previousScheduledTime?: string; nextScheduledTime?: string },
  ): Promise<void> {
    if (!inst?.task || inst.task.isRoutine) {
      return
    }

    await this.host.ensureDayStateForCurrentDate()
    if (!this.isDuplicatedTask(inst)) {
      return
    }

    const sectionConfig = this.host.getSectionConfig()
    const previousSlot = params.previousScheduledTime
      ? sectionConfig.calculateSlotKeyFromTime(params.previousScheduledTime)
      : undefined
    const nextSlot = params.nextScheduledTime
      ? sectionConfig.calculateSlotKeyFromTime(params.nextScheduledTime)
      : undefined
    const currentSlot = inst.slotKey || 'none'
    const shouldSync = currentSlot === 'none' || (previousSlot !== undefined && currentSlot === previousSlot)

    if (!shouldSync) {
      return
    }

    const targetSlot = nextSlot ?? 'none'
    if (targetSlot === currentSlot) {
      return
    }

    await this.moveInstanceToSlot(inst, targetSlot)
  }

  async moveInstanceToSlot(inst: TaskInstance, newSlot: string, stateInsertIndex?: number): Promise<void> {
    const previousSlot = inst.slotKey ?? 'none'
    const previousOrder = inst.order
    try {
      await this.host.ensureDayStateForCurrentDate()
      const targetSlot = newSlot || 'none'
      const normalizedState = this.host.normalizeState(inst.state)
      const peerTasks = this.host.taskInstances.filter(
        (task) =>
          task !== inst &&
          (task.slotKey || 'none') === targetSlot &&
          this.host.normalizeState(task.state) === normalizedState,
      )
      const insertIndex =
        stateInsertIndex !== undefined ? Math.max(0, Math.min(stateInsertIndex, peerTasks.length)) : peerTasks.length

      inst.slotKey = targetSlot
      inst.order = this.host.calculateSimpleOrder(insertIndex, peerTasks)
      await this.host.saveTaskOrders()
      this.persistSlotAssignment(inst)
      this.host.sortTaskInstancesByTimeOrder()
      this.safeRenderTaskList()
    } catch (error) {
      console.error('[TaskMutationService] moveInstanceToSlot failed', error)
      inst.slotKey = previousSlot
      inst.order = previousOrder
      new Notice(this.host.tv('notices.taskMoveFailed', 'Failed to move task'))
    }
  }

  private async deleteNonRoutineTask(inst: TaskInstance): Promise<boolean> {
    const deleted = await this.deleteInstance(inst)
    if (deleted && inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }
    return deleted
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<boolean> {
    const dateKey = this.host.getCurrentDateString()
    await this.host.ensureDayStateForCurrentDate()
    const dayState = this.host.getCurrentDayState()
    const previousHiddenRoutines = [...dayState.hiddenRoutines]
    const isDuplicated = this.isDuplicatedTask(inst)

    const matchesEntry = (entry: HiddenRoutineEntry): boolean => {
      if (!entry) return false
      if (typeof entry === 'string') {
        return !isDuplicated && entry === inst.task.path
      }
      if (isDuplicated) {
        return entry.instanceId === inst.instanceId
      }
      return entry.path === inst.task.path && !entry.instanceId
    }
    const isActiveHidden = (entry: HiddenRoutineEntry): boolean => {
      if (!entry) return false
      if (typeof entry === 'string') {
        return true
      }
      return isHiddenEntry(entry)
    }
    const restoreHiddenRoutines = async (): Promise<void> => {
      dayState.hiddenRoutines = previousHiddenRoutines
      try {
        await this.host.persistDayState(dateKey)
      } catch (error) {
        console.warn(
          '[TaskMutationService] routine delete rollback persist failed',
          error,
        )
      }
    }

    try {
      const alreadyHidden = dayState.hiddenRoutines.some(
        (entry) => matchesEntry(entry) && isActiveHidden(entry),
      )

      if (!alreadyHidden) {
        const now = Date.now()
        const existingIndex = dayState.hiddenRoutines.findIndex((entry) =>
          matchesEntry(entry),
        )
        if (existingIndex >= 0) {
          const existing = dayState.hiddenRoutines[existingIndex]
          if (typeof existing === 'string') {
            dayState.hiddenRoutines[existingIndex] = {
              path: existing,
              instanceId: null,
              hiddenAt: now,
            }
          } else if (existing) {
            dayState.hiddenRoutines[existingIndex] = {
              ...existing,
              hiddenAt: now,
              restoredAt: undefined,
            }
          }
        } else {
          dayState.hiddenRoutines.push({
            path: inst.task.path,
            instanceId: isDuplicated ? inst.instanceId : null,
            hiddenAt: now,
          })
        }
        await this.host.persistDayState(dateKey)
      }

      const deleted = await this.deleteInstance(inst)
      if (!deleted) {
        await restoreHiddenRoutines()
        return false
      }

      if (inst.instanceId) {
        await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
      }
      return true
    } catch (error) {
      await restoreHiddenRoutines()
      throw error
    }
  }

  private assignDuplicateOrder(newInst: TaskInstance, originalInst: TaskInstance): void {
    try {
      const targetSlot = newInst.slotKey || originalInst.slotKey || 'none'
      const normalizedState = this.host.normalizeState(originalInst.state)
      const peers = this.host.taskInstances.filter(
        (task) =>
          task !== newInst &&
          (task.slotKey || 'none') === targetSlot &&
          this.host.normalizeState(task.state) === normalizedState,
      )
      const sortedPeers = [...peers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const originalSlot = originalInst.slotKey || 'none'
      const originalIndex =
        targetSlot === originalSlot ? sortedPeers.indexOf(originalInst) : -1
      const insertIndex = originalIndex >= 0 ? originalIndex + 1 : sortedPeers.length
      newInst.slotKey = targetSlot
      newInst.order = this.host.calculateSimpleOrder(insertIndex, peers)
    } catch (error) {
      console.warn('[TaskMutationService] assignDuplicateOrder fallback', error)
      newInst.order = (originalInst.order ?? 0) + 100
    }
  }

  private async handleTaskFileDeletion(inst: TaskInstance): Promise<void> {
    if (!inst.task.path) return
    const remaining = this.host.taskInstances.filter((candidate) => candidate.task.path === inst.task.path)
    if (remaining.length > 0) {
      new Notice(this.host.tv('notices.taskRemovedFromToday', 'Removed task from the list.'))
      return
    }

    this.host.tasks = this.host.tasks.filter((task) => task.path !== inst.task.path)
    const file = inst.task.file
    if (file instanceof TFile) {
      try {
        await this.host.app.fileManager.trashFile(file)
        new Notice(this.host.tv('notices.taskDeletedPermanent', 'Permanently deleted the task.'))
        return
      } catch (error) {
        console.warn('[TaskMutationService] trashFile failed', error)
      }
    }
    new Notice(this.host.tv('notices.taskRemovedFromToday', 'Removed task from the list.'))
  }

  private getScheduledTime(task: TaskData): string | undefined {
    const candidate = (task as TaskData & { scheduledTime?: unknown }).scheduledTime
    return typeof candidate === 'string' ? candidate : undefined
  }

  private safeRenderTaskList(): void {
    try {
      this.host.renderTaskList()
    } catch (error) {
      console.warn('[TaskMutationService] renderTaskList skipped', error)
    }
  }

  private extractDateKeyFromInstanceId(instanceId: string): string | null {
    if (!instanceId) {
      return null
    }
    const match = instanceId.match(/\d{4}-\d{2}-\d{2}/)
    return match ? match[0] : null
  }
}
