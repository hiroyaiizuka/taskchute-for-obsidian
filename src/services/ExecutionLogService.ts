import { TFile } from 'obsidian';
import TaskChutePlugin from '../main';
import { TaskInstance } from '../types';

export class ExecutionLogService {
  constructor(private plugin: TaskChutePlugin) {}

  private toHMS(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  private getMonthKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private getDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  async saveTaskLog(inst: TaskInstance, durationSec: number): Promise<void> {
    if (!inst.startTime || !inst.stopTime) return;
    const start = new Date(inst.startTime);
    const monthKey = this.getMonthKey(start);
    const dateKey = this.getDateKey(start);
    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const logPath = `${logDataPath}/${monthKey}-tasks.json`;

    // Load
    let file = this.plugin.app.vault.getAbstractFileByPath(logPath) as TFile | null;
    let json: any = { taskExecutions: {}, dailySummary: {} };
    if (file && file instanceof TFile) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        json = raw ? JSON.parse(raw) : json;
      } catch (_) {}
    } else {
      await this.plugin.pathManager.ensureFolderExists(logDataPath);
      await this.plugin.app.vault.create(logPath, JSON.stringify(json, null, 2));
      file = this.plugin.app.vault.getAbstractFileByPath(logPath) as TFile;
    }

    if (!json.taskExecutions) json.taskExecutions = {};
    if (!json.dailySummary) json.dailySummary = {};
    if (!json.taskExecutions[dateKey]) json.taskExecutions[dateKey] = [];

    const exec = {
      taskTitle: inst.task.title || inst.task.name,
      taskPath: inst.task.path,
      instanceId: inst.instanceId,
      slotKey: inst.slotKey,
      startTime: this.toHMS(start),
      stopTime: this.toHMS(inst.stopTime!),
      durationSec,
    };

    const arr: any[] = json.taskExecutions[dateKey];
    const idx = arr.findIndex((e) => e.instanceId === exec.instanceId);
    if (idx >= 0) arr[idx] = exec; else arr.push(exec);

    // Recompute daily summary
    const totalMinutes = arr.reduce((s, e) => s + Math.floor(((e.durationSec || 0) / 60)), 0);
    json.dailySummary[dateKey] = {
      totalMinutes,
      totalTasks: arr.length,
      completedTasks: arr.length,
      procrastinatedTasks: json.dailySummary[dateKey]?.procrastinatedTasks || 0,
      completionRate: arr.length > 0 ? 1 : 0,
    };

    await this.plugin.app.vault.modify(file as TFile, JSON.stringify(json, null, 2));
  }

  async removeTaskLogForInstanceOnDate(instanceId: string, dateKey: string): Promise<void> {
    try {
      const [y, m] = dateKey.split('-');
      const monthKey = `${y}-${m}`;
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const logPath = `${logDataPath}/${monthKey}-tasks.json`;

      const file = this.plugin.app.vault.getAbstractFileByPath(logPath);
      if (!file || !(file instanceof TFile)) return;

      const raw = await this.plugin.app.vault.read(file);
      if (!raw) return;
      let json: any = {};
      try { json = JSON.parse(raw); } catch (_) { return; }
      if (!json.taskExecutions || !Array.isArray(json.taskExecutions[dateKey])) return;

      const filtered = json.taskExecutions[dateKey].filter((e: any) => e.instanceId !== instanceId);
      json.taskExecutions[dateKey] = filtered;

      // Recompute summary
      const totalMinutes = filtered.reduce((s: number, e: any) => s + Math.floor(((e.durationSec || 0) / 60)), 0);
      if (!json.dailySummary) json.dailySummary = {};
      json.dailySummary[dateKey] = {
        totalMinutes,
        totalTasks: filtered.length,
        completedTasks: filtered.length,
        procrastinatedTasks: json.dailySummary[dateKey]?.procrastinatedTasks || 0,
        completionRate: filtered.length > 0 ? 1 : 0,
      };

      await this.plugin.app.vault.modify(file, JSON.stringify(json, null, 2));
    } catch (_) {
      // noop
    }
  }
}

