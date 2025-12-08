import { TFile } from 'obsidian'
import type {
  DeletedInstance,
  HiddenRoutine,
  TaskChutePluginLike,
  TaskData,
  TaskInstance,
} from '../../../types'
import { getCurrentTimeSlot } from '../../../utils/time'

export interface RunningTaskRecord {
  date: string;
  taskTitle: string;
  taskPath: string;
  startTime: string; // ISO
  slotKey?: string;
  originalSlotKey?: string;
  instanceId?: string;
  taskDescription?: string;
  isRoutine?: boolean;
  taskId?: string;
}

export class RunningTasksService {
  constructor(private plugin: TaskChutePluginLike) {}

  private isRunningTaskRecord(value: unknown): value is RunningTaskRecord {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record.date === 'string' &&
      typeof record.taskTitle === 'string' &&
      typeof record.taskPath === 'string' &&
      typeof record.startTime === 'string'
    );
  }

  async save(runningInstances: TaskInstance[]): Promise<void> {
    const records: RunningTaskRecord[] = runningInstances.map((inst) => {
      const base = inst.startTime ? new Date(inst.startTime) : new Date();
      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      const d = String(base.getDate()).padStart(2, '0');
      const dateString = `${y}-${m}-${d}`;
      const descriptionField = inst.task?.description;
      const taskDescription =
        typeof descriptionField === 'string' ? descriptionField : undefined;
      return {
        date: dateString,
        taskTitle: inst.task.name,
        taskPath: inst.task.path,
        startTime: (inst.startTime ? inst.startTime : new Date()).toISOString(),
        slotKey: inst.slotKey,
        originalSlotKey: inst.originalSlotKey,
        instanceId: inst.instanceId,
        taskDescription,
        isRoutine: inst.task.isRoutine === true,
        taskId: inst.task.taskId,
      };
    });

    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const dataPath = `${logDataPath}/running-task.json`;

    await this.plugin.app.vault.adapter.write(
      dataPath,
      JSON.stringify(records, null, 2)
    );
  }

  async deleteByInstanceOrPath(options: {
    instanceId?: string
    taskPath?: string
    taskId?: string
  }): Promise<number> {
    const { instanceId, taskPath, taskId } = options
    if (!instanceId && !taskPath && !taskId) return 0

    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const dataPath = `${logDataPath}/running-task.json`;
      const file = this.plugin.app.vault.getAbstractFileByPath(dataPath);
      if (!file || !(file instanceof TFile)) return 0;

      const raw = await this.plugin.app.vault.read(file);
      if (!raw) return 0;

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return 0;

      const records = parsed as RunningTaskRecord[];
      const filtered = records.filter((record) => {
        if (!record || typeof record !== 'object') return false;
        const matchesInstance = instanceId && record.instanceId === instanceId;
        const matchesPath = taskPath && record.taskPath === taskPath;
        const matchesTaskId = taskId && record.taskId === taskId;
        return !(matchesInstance || matchesPath || matchesTaskId);
      });

      if (filtered.length === records.length) {
        return 0;
      }

      await this.plugin.app.vault.modify(
        file,
        JSON.stringify(filtered, null, 2),
      );
      return records.length - filtered.length;
    } catch (error) {
      console.warn('[RunningTasksService] Failed to delete running task record', error);
      return 0;
    }
  }

  async loadForDate(dateString: string): Promise<RunningTaskRecord[]> {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const dataPath = `${logDataPath}/running-task.json`;
      const file = this.plugin.app.vault.getAbstractFileByPath(dataPath);
      if (!file || !(file instanceof TFile)) return [];
      const raw = await this.plugin.app.vault.read(file);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is RunningTaskRecord => this.isRunningTaskRecord(entry))
        .filter((record) => record.date === dateString);
    } catch {
      return [];
    }
  }

  async renameTaskPath(oldPath: string, newPath: string, options: { newTitle?: string } = {}): Promise<void> {
    const normalizedOld = typeof oldPath === 'string' ? oldPath.trim() : '';
    const normalizedNew = typeof newPath === 'string' ? newPath.trim() : '';
    if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
      return;
    }

    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const dataPath = `${logDataPath}/running-task.json`;
      const file = this.plugin.app.vault.getAbstractFileByPath(dataPath);
      if (!file || !(file instanceof TFile)) {
        return;
      }

      const raw = await this.plugin.app.vault.read(file);
      if (!raw) {
        return;
      }

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      let mutated = false;
      const updated = (parsed as RunningTaskRecord[]).map((record) => {
        if (!record || typeof record !== 'object') {
          return record;
        }
        if (record.taskPath === normalizedOld) {
          mutated = true;
          const next: RunningTaskRecord = { ...record, taskPath: normalizedNew };
          if (options.newTitle && typeof options.newTitle === 'string' && options.newTitle.trim().length > 0) {
            next.taskTitle = options.newTitle.trim();
          }
          return next;
        }
        return record;
      });

      if (mutated) {
        await this.plugin.app.vault.modify(file, JSON.stringify(updated, null, 2));
      }
    } catch (error) {
      console.warn('[RunningTasksService] Failed to rename task path', error);
    }
  }

  async restoreForDate(options: {
    dateString: string
    instances: TaskInstance[]
    deletedPaths: string[]
    hiddenRoutines: Array<HiddenRoutine | string>
    deletedInstances: DeletedInstance[]
    findTaskByPath: (path: string) => TaskData | undefined
    generateInstanceId: (task: TaskData) => string
  }): Promise<TaskInstance[]> {
    const {
      dateString,
      instances,
      deletedPaths,
      hiddenRoutines,
      deletedInstances,
      findTaskByPath,
      generateInstanceId,
    } = options
    const records = await this.loadForDate(dateString)
    const restoredInstances: TaskInstance[] = []
    const hiddenEntries = hiddenRoutines ?? []
    const deletedEntries = deletedInstances ?? []

    const isHiddenRecord = (record: RunningTaskRecord): boolean => {
      return hiddenEntries.some((entry) => {
        if (!entry) return false
        if (typeof entry === 'string') {
          return entry === record.taskPath
        }
        if (entry.instanceId && record.instanceId) {
          return entry.instanceId === record.instanceId
        }
        if (entry.instanceId && !record.instanceId && entry.path === record.taskPath) {
          return true
        }
        return entry.path === record.taskPath
      })
    }

    const isDeletedRecord = (record: RunningTaskRecord): boolean => {
      return deletedEntries.some((entry) => {
        if (!entry) return false
        const hasInstanceId = typeof entry.instanceId === 'string' && entry.instanceId.length > 0
        const instanceMatches = hasInstanceId && record.instanceId && entry.instanceId === record.instanceId
        if (instanceMatches) {
          return true
        }

        const pathMatches = entry.path && record.taskPath && entry.path === record.taskPath
        if (!pathMatches) {
          return false
        }

        if (hasInstanceId) {
          // Instance-scoped deletions should not suppress other instances for the same path
          if (!record.instanceId) {
            return true
          }
          return false
        }

        if (entry.deletionType === 'permanent') {
          return true
        }

        if (entry.deletionType === 'temporary' && record.isRoutine === true) {
          return true
        }

        return false
      })
    }

    for (const record of records) {
      if (record.date !== dateString) continue
      if (record.taskPath && deletedPaths.includes(record.taskPath)) continue
      if (isHiddenRecord(record)) continue
      if (isDeletedRecord(record)) continue

      let runningInstance = instances.find((inst) => inst.instanceId === record.instanceId)
      if (!runningInstance) {
        runningInstance = instances.find(
          (inst) => inst.task.path === record.taskPath && inst.state === 'idle',
        )
      }

      if (runningInstance) {
        try {
          const desiredSlot = record.slotKey || getCurrentTimeSlot(new Date())
          if (runningInstance.slotKey !== desiredSlot) {
            if (!runningInstance.originalSlotKey) {
              runningInstance.originalSlotKey = runningInstance.slotKey
            }
            runningInstance.slotKey = desiredSlot
          }
        } catch {
          /* ignore slot errors */
        }

        runningInstance.state = 'running'
        runningInstance.startTime = new Date(record.startTime)
        runningInstance.stopTime = undefined
        if (record.instanceId && runningInstance.instanceId !== record.instanceId) {
          runningInstance.instanceId = record.instanceId
        }
        if (!runningInstance.originalSlotKey && record.originalSlotKey) {
          runningInstance.originalSlotKey = record.originalSlotKey
        }
        if (!restoredInstances.includes(runningInstance)) {
          restoredInstances.push(runningInstance)
        }
        continue
      }

      const taskData = record.taskPath ? findTaskByPath(record.taskPath) : undefined
      if (!taskData) continue

      const recreated: TaskInstance = {
        task: taskData,
        instanceId: record.instanceId || generateInstanceId(taskData),
        state: 'running',
        slotKey: record.slotKey || getCurrentTimeSlot(new Date()),
        originalSlotKey: record.originalSlotKey,
        startTime: new Date(record.startTime),
        stopTime: undefined,
        createdMillis: taskData.createdMillis,
      }
      instances.push(recreated)
      restoredInstances.push(recreated)
    }

    return restoredInstances
  }
}
