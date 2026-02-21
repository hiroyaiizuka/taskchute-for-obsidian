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
}

interface MutationDayState {
  hiddenRoutines: HiddenRoutineEntry[]
  deletedInstances: DeletedInstance[]
  duplicatedInstances: DuplicatedEntry[]
  slotOverrides: Record<string, string>
  slotOverridesMeta?: Record<string, SlotOverrideEntry>
  orders?: Record<string, number>
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
  constructor(private readonly host: TaskMutationHost) {}

  async duplicateInstance(
    inst: TaskInstance,
    options: { returnInstance?: boolean; slotKey?: string } = {},
  ): Promise<TaskInstance | void> {
    try {
      await this.host.ensureDayStateForCurrentDate()
      const dateKey = this.host.getCurrentDateString()
      const createdMillis = Date.now()
      const slotKey = options.slotKey ?? inst.slotKey ?? 'none'
      const originalSlotKey = inst.slotKey ?? slotKey
      const newInstance: TaskInstance = {
        task: inst.task,
        instanceId: this.host.generateInstanceId(inst.task, dateKey),
        state: 'idle',
        slotKey,
        originalSlotKey,
        createdMillis,
      }

      this.assignDuplicateOrder(newInstance, inst)
      this.host.taskInstances.push(newInstance)

      const dayState = this.host.getCurrentDayState()
      if (!dayState.duplicatedInstances.some((dup) => dup.instanceId === newInstance.instanceId)) {
        dayState.duplicatedInstances.push({
          instanceId: newInstance.instanceId,
          originalPath: inst.task.path,
          slotKey: newInstance.slotKey,
          originalSlotKey,
          timestamp: createdMillis,
          createdMillis,
          originalTaskId: inst.task.taskId,
        })
        await this.host.persistDayState(dateKey)
      }

      this.safeRenderTaskList()
      new Notice(
        this.host.tv('notices.taskDuplicated', 'Duplicated "{title}"', {
          title: this.host.getInstanceDisplayTitle(inst),
        }),
      )

      if (options.returnInstance) {
        return newInstance
      }
    } catch (error) {
      console.error('[TaskMutationService] duplicateInstance failed', error)
      new Notice(this.host.tv('notices.taskDuplicateFailed', 'Failed to duplicate task'))
    }
    return undefined
  }

  async deleteTask(inst: TaskInstance): Promise<void> {
    if (!inst) return
    if (inst.task.isRoutine) {
      await this.deleteRoutineTask(inst)
    } else {
      await this.deleteNonRoutineTask(inst)
    }
  }

  async deleteInstance(inst: TaskInstance): Promise<void> {
    try {
      await this.host.ensureDayStateForCurrentDate()
      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      const taskId = inst.task.taskId
      const hadSiblingWithSamePath = this.host.taskInstances.some(
        (candidate) => candidate !== inst && candidate.task?.path === inst.task.path,
      )
      const index = this.host.taskInstances.indexOf(inst)
      if (index > -1) {
        this.host.taskInstances.splice(index, 1)
      }

      const dateKey = this.host.getCurrentDateString()
      const dayState = this.host.getCurrentDayState()
      const deletedEntries = [...this.host.dayStateManager.getDeleted(dateKey)]
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
        dayState.duplicatedInstances = dayState.duplicatedInstances.filter(
          (entry) =>
            entry.instanceId !== inst.instanceId && entry.originalPath !== inst.task.path,
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
        await this.host.removeRunningTaskRecord({
          instanceId: inst.instanceId,
        })
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
    } catch (error) {
      console.error('[TaskMutationService] deleteInstance failed', error)
      new Notice(this.host.tv('notices.taskDeleteFailed', 'Failed to delete task'))
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

  private async deleteNonRoutineTask(inst: TaskInstance): Promise<void> {
    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }
    await this.deleteInstance(inst)
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<void> {
    const dateKey = this.host.getCurrentDateString()
    await this.host.ensureDayStateForCurrentDate()
    const dayState = this.host.getCurrentDayState()
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
    const alreadyHidden = dayState.hiddenRoutines.some(
      (entry) => matchesEntry(entry) && isActiveHidden(entry),
    )

    if (!alreadyHidden) {
      const now = Date.now()
      const existingIndex = dayState.hiddenRoutines.findIndex((entry) => matchesEntry(entry))
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

    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }

    await this.deleteInstance(inst)
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
