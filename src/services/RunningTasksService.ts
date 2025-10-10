import { TFile } from 'obsidian'
import type { TaskChutePluginLike, TaskData } from '../types'
import { TaskInstance } from '../types'
import { getCurrentTimeSlot } from '../utils/time'

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
      };
    });

    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const dataPath = `${logDataPath}/running-task.json`;

    await this.plugin.app.vault.adapter.write(
      dataPath,
      JSON.stringify(records, null, 2)
    );
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

  async restoreForDate(options: {
    dateString: string
    instances: TaskInstance[]
    deletedPaths: string[]
    findTaskByPath: (path: string) => TaskData | undefined
    generateInstanceId: (task: TaskData) => string
  }): Promise<TaskInstance[]> {
    const { dateString, instances, deletedPaths, findTaskByPath, generateInstanceId } = options
    const records = await this.loadForDate(dateString)
    const restoredInstances: TaskInstance[] = []

    for (const record of records) {
      if (record.date !== dateString) continue
      if (record.taskPath && deletedPaths.includes(record.taskPath)) continue

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
      }
      instances.push(recreated)
      restoredInstances.push(recreated)
    }

    return restoredInstances
  }
}
