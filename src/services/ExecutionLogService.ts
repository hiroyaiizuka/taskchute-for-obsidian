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

    // Recompute daily summary (do NOT equate totalTasks with completed)
    const totalMinutes = arr.reduce((s, e) => s + Math.floor(((e.durationSec || e.duration || 0) / 60)), 0);
    // completed = unique tasks completed on the day
    const toKey = (e: any) => (e.taskPath && typeof e.taskPath === 'string' && e.taskPath)
      || (e.taskName && typeof e.taskName === 'string' && e.taskName)
      || (e.taskTitle && typeof e.taskTitle === 'string' && e.taskTitle)
      || (e.instanceId && typeof e.instanceId === 'string' && e.instanceId)
      || JSON.stringify(e);
    const isCompleted = (e: any) => {
      if (typeof e.isCompleted === 'boolean') return e.isCompleted;
      if (e.stopTime && typeof e.stopTime === 'string' && e.stopTime.trim().length > 0) return true;
      if (typeof e.durationSec === 'number' && e.durationSec > 0) return true;
      if (typeof e.duration === 'number' && e.duration > 0) return true;
      return true; // entries here are produced at stop time; treat as completed by default
    };
    const completedSet = new Set<string>();
    for (const e of arr) {
      if (isCompleted(e)) completedSet.add(toKey(e));
    }
    const completedTasks = completedSet.size;
    const prev = json.dailySummary[dateKey] || {};
    const totalTasks = typeof prev.totalTasks === 'number' ? prev.totalTasks : Math.max(completedTasks, 0);
    const procrastinatedTasks = Math.max(0, totalTasks - completedTasks);
    const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;

    json.dailySummary[dateKey] = {
      ...prev,
      totalMinutes,
      totalTasks,
      completedTasks,
      procrastinatedTasks,
      completionRate,
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

      // Recompute summary with corrected logic
      const totalMinutes = filtered.reduce((s: number, e: any) => s + Math.floor(((e.durationSec || e.duration || 0) / 60)), 0);
      if (!json.dailySummary) json.dailySummary = {};
      const toKey = (e: any) => (e.taskPath && typeof e.taskPath === 'string' && e.taskPath)
        || (e.taskName && typeof e.taskName === 'string' && e.taskName)
        || (e.taskTitle && typeof e.taskTitle === 'string' && e.taskTitle)
        || (e.instanceId && typeof e.instanceId === 'string' && e.instanceId)
        || JSON.stringify(e);
      const isCompleted = (e: any) => {
        if (typeof e.isCompleted === 'boolean') return e.isCompleted;
        if (e.stopTime && typeof e.stopTime === 'string' && e.stopTime.trim().length > 0) return true;
        if (typeof e.durationSec === 'number' && e.durationSec > 0) return true;
        if (typeof e.duration === 'number' && e.duration > 0) return true;
        return true;
      };
      const completedSet = new Set<string>();
      for (const e of filtered) {
        if (isCompleted(e)) completedSet.add(toKey(e));
      }
      const completedTasks = completedSet.size;
      const prev = json.dailySummary[dateKey] || {};
      const totalTasks = typeof prev.totalTasks === 'number' ? prev.totalTasks : Math.max(completedTasks, 0);
      const procrastinatedTasks = Math.max(0, totalTasks - completedTasks);
      const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;

      json.dailySummary[dateKey] = {
        ...prev,
        totalMinutes,
        totalTasks,
        completedTasks,
        procrastinatedTasks,
        completionRate,
      };

      await this.plugin.app.vault.modify(file, JSON.stringify(json, null, 2));
    } catch (_) {
      // noop
    }
  }
}
