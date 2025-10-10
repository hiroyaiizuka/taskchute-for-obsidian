import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import { getSlotFromTime } from '../utils/time'
import {
  TaskInstance,
  TaskData,
  HiddenRoutine,
  DeletedInstance,
} from '../types'
import { parseTaskLogSnapshot } from '../utils/executionLogUtils'
import type DayStateManager from './DayStateManager'

type HiddenRoutineEntry = HiddenRoutine | string

type DuplicatedEntry = {
  instanceId?: string
  originalPath?: string
  slotKey?: string
  originalSlotKey?: string
  timestamp?: number
}

interface MutationDayState {
  hiddenRoutines: HiddenRoutineEntry[]
  deletedInstances: DeletedInstance[]
  duplicatedInstances: DuplicatedEntry[]
  slotOverrides: Record<string, string>
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
  dayStateManager: DayStateManager
}

export default class TaskMutationService {
  constructor(private readonly host: TaskMutationHost) {}

  async duplicateInstance(
    inst: TaskInstance,
    options: { returnInstance?: boolean } = {},
  ): Promise<TaskInstance | void> {
    try {
      await this.host.ensureDayStateForCurrentDate()
      const dateKey = this.host.getCurrentDateString()
      const newInstance: TaskInstance = {
        task: inst.task,
        instanceId: this.host.generateInstanceId(inst.task, dateKey),
        state: 'idle',
        slotKey: inst.slotKey,
        originalSlotKey: inst.slotKey,
      }

      this.assignDuplicateOrder(newInstance, inst)
      this.host.taskInstances.push(newInstance)

      const dayState = this.host.getCurrentDayState()
      if (!dayState.duplicatedInstances.some((dup) => dup.instanceId === newInstance.instanceId)) {
        dayState.duplicatedInstances.push({
          instanceId: newInstance.instanceId,
          originalPath: inst.task.path,
          slotKey: newInstance.slotKey,
          originalSlotKey: inst.slotKey,
          timestamp: Date.now(),
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
      const index = this.host.taskInstances.indexOf(inst)
      if (index > -1) {
        this.host.taskInstances.splice(index, 1)
      }

      const dateKey = this.host.getCurrentDateString()
      const dayState = this.host.getCurrentDayState()
      const deletedEntries = [...this.host.dayStateManager.getDeleted(dateKey)]
      const isDuplicate = this.isDuplicatedTask(inst)
      const timestamp = Date.now()

      if (isDuplicate) {
        deletedEntries.push({
          instanceId: inst.instanceId,
          path: inst.task.path,
          deletionType: 'temporary',
          timestamp,
        })
        dayState.duplicatedInstances = dayState.duplicatedInstances.filter(
          (entry) => entry.instanceId !== inst.instanceId,
        )
      } else if (!inst.task.isRoutine) {
        const hasValidPath = typeof inst.task.path === 'string' && inst.task.path.length > 0
        if (hasValidPath) {
          deletedEntries.push({
            path: inst.task.path,
            deletionType: 'permanent',
            timestamp,
          })
        } else {
          deletedEntries.push({
            instanceId: inst.instanceId,
            path: inst.task.path,
            deletionType: 'temporary',
            timestamp,
          })
        }
      } else {
        deletedEntries.push({
          instanceId: inst.instanceId,
          path: inst.task.path,
          deletionType: 'temporary',
          timestamp,
        })
      }

      this.host.dayStateManager.setDeleted(deletedEntries, dateKey)
      await this.host.persistDayState(dateKey)

      if (!inst.task.isRoutine) {
        this.handleTaskFileDeletion(inst)
      } else {
        new Notice(
          this.host.tv(
            'notices.taskRemovedFromTodayWithTitle',
            'Removed "{title}" from today.',
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
      const logDataPath = this.host.plugin.pathManager.getLogDataPath()
      const [year, month] = this.host.getCurrentDateString().split('-')
      const logPath = `${logDataPath}/${year}-${month}-tasks.json`
      const file = this.host.app.vault.getAbstractFileByPath(logPath)
      if (!file || !(file instanceof TFile)) {
        return 0
      }

      const raw = await this.host.app.vault.read(file)
      const monthlyLog = parseTaskLogSnapshot(raw)

      let deletedCount = 0
      Object.keys(monthlyLog.taskExecutions).forEach((dayKey) => {
        const executions = monthlyLog.taskExecutions[dayKey] ?? []
        const before = executions.length
        monthlyLog.taskExecutions[dayKey] = executions.filter((entry) => entry?.instanceId !== instanceId)
        deletedCount += before - monthlyLog.taskExecutions[dayKey].length
      })

      if (deletedCount > 0) {
        await this.host.app.vault.modify(file, JSON.stringify(monthlyLog, null, 2))
      }
      return deletedCount
    } catch (error) {
      console.warn('[TaskMutationService] deleteTaskLogsByInstanceId failed', error)
      return 0
    }
  }

  persistSlotAssignment(inst: TaskInstance): void {
    const dayState = this.host.getCurrentDayState()
    const taskPath = inst.task.path
    const scheduledTime = this.getScheduledTime(inst.task)

    if (taskPath) {
      if (inst.task.isRoutine) {
        const updatedSlot = inst.slotKey || 'none'
        const defaultSlot = scheduledTime ? getSlotFromTime(scheduledTime) : 'none'
        if (updatedSlot === defaultSlot) {
          delete dayState.slotOverrides[taskPath]
        } else {
          dayState.slotOverrides[taskPath] = updatedSlot
        }
      } else {
        if (!this.host.plugin.settings.slotKeys) {
          this.host.plugin.settings.slotKeys = {}
        }
        this.host.plugin.settings.slotKeys[taskPath] = inst.slotKey || 'none'
        void this.host.plugin.saveSettings()
      }
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

    const alreadyHidden = dayState.hiddenRoutines.some((entry) => {
      if (typeof entry === 'string') {
        return !isDuplicated && entry === inst.task.path
      }
      if (isDuplicated) {
        return entry.instanceId === inst.instanceId
      }
      return entry.path === inst.task.path && !entry.instanceId
    })

    if (!alreadyHidden) {
      dayState.hiddenRoutines.push({
        path: inst.task.path,
        instanceId: isDuplicated ? inst.instanceId : null,
      })
      await this.host.persistDayState(dateKey)
    }

    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }

    await this.deleteInstance(inst)
  }

  private assignDuplicateOrder(newInst: TaskInstance, originalInst: TaskInstance): void {
    try {
      const slot = originalInst.slotKey || 'none'
      const normalizedState = this.host.normalizeState(originalInst.state)
      const peers = this.host.taskInstances.filter(
        (task) =>
          task !== newInst &&
          (task.slotKey || 'none') === slot &&
          this.host.normalizeState(task.state) === normalizedState,
      )
      const sortedPeers = [...peers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const originalIndex = sortedPeers.indexOf(originalInst)
      const insertIndex = originalIndex >= 0 ? originalIndex + 1 : sortedPeers.length
      newInst.slotKey = slot
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
      new Notice(this.host.tv('notices.taskRemovedFromToday', 'Removed task from today.'))
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
    new Notice(this.host.tv('notices.taskRemovedFromToday', 'Removed task from today.'))
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
}
