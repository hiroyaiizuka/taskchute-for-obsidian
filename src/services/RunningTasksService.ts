import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../types';
import { TaskInstance } from '../types';

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
      return {
        date: dateString,
        taskTitle: inst.task.name,
        taskPath: inst.task.path,
        startTime: (inst.startTime ? inst.startTime : new Date()).toISOString(),
        slotKey: inst.slotKey,
        originalSlotKey: inst.originalSlotKey,
        instanceId: inst.instanceId,
        taskDescription: inst.task.description || '',
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
}
