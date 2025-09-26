import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../types';
import { TaskInstance } from '../types';
import { computeExecutionInstanceKey } from '../utils/logKeys';


interface TaskExecutionEntry {
  taskTitle?: string;
  taskName?: string;
  taskPath?: string;
  instanceId?: string;
  slotKey?: string;
  startTime?: string;
  stopTime?: string;
  durationSec?: number;
  duration?: number;
  isCompleted?: boolean;
  [key: string]: unknown;
}

interface DailySummaryEntry {
  totalMinutes?: number;
  totalTasks?: number;
  completedTasks?: number;
  procrastinatedTasks?: number;
  completionRate?: number;
  [key: string]: unknown;
}

interface TaskLogFile {
  taskExecutions: Record<string, TaskExecutionEntry[]>;
  dailySummary: Record<string, DailySummaryEntry>;
  totalTasks?: number;
  [key: string]: unknown;
}

const EMPTY_LOG_FILE: TaskLogFile = {
  taskExecutions: {},
  dailySummary: {},
};

function parseLogFile(raw: string | null | undefined): TaskLogFile {
  if (!raw) {
    return { ...EMPTY_LOG_FILE };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TaskLogFile>;
    return {
      taskExecutions: parsed.taskExecutions ?? {},
      dailySummary: parsed.dailySummary ?? {},
      ...parsed,
    };
  } catch (error) {
    console.warn('[ExecutionLogService] Failed to parse log file', error);
    return { ...EMPTY_LOG_FILE };
  }
}

function isEntryCompleted(entry: TaskExecutionEntry): boolean {
  if (typeof entry.isCompleted === 'boolean') return entry.isCompleted;
  if (entry.stopTime && typeof entry.stopTime === 'string' && entry.stopTime.trim().length > 0) return true;
  if (typeof entry.durationSec === 'number' && entry.durationSec > 0) return true;
  if (typeof entry.duration === 'number' && entry.duration > 0) return true;
  return true;
}

function minutesFromEntries(entries: TaskExecutionEntry[]): number {
  return entries.reduce((sum, entry) => {
    const duration = entry.durationSec ?? entry.duration ?? 0;
    return sum + Math.floor(duration / 60);
  }, 0);
}

export class ExecutionLogService {
  constructor(private plugin: TaskChutePluginLike) {}

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
    const abstract = this.plugin.app.vault.getAbstractFileByPath(logPath);
    let file = abstract instanceof TFile ? abstract : null;
    let json: TaskLogFile = { ...EMPTY_LOG_FILE };
    if (file && file instanceof TFile) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        json = parseLogFile(raw);
      } catch (error) {
        console.warn("[ExecutionLogService] Failed to read log file", error);
        json = { ...EMPTY_LOG_FILE };
      }
    } else {
      await this.plugin.pathManager.ensureFolderExists(logDataPath);
      await this.plugin.app.vault.create(logPath, JSON.stringify(json, null, 2));
      const created = this.plugin.app.vault.getAbstractFileByPath(logPath);
      file = created instanceof TFile ? created : null;
    }

    if (!json.taskExecutions[dateKey]) {
      json.taskExecutions[dateKey] = [];
    }

    const exec: TaskExecutionEntry = {
      taskTitle: inst.task.title || inst.task.name,
      taskPath: inst.task.path,
      instanceId: inst.instanceId,
      slotKey: inst.slotKey,
      startTime: this.toHMS(start),
      stopTime: this.toHMS(inst.stopTime!),
      durationSec,
    };

    const arr: TaskExecutionEntry[] = json.taskExecutions[dateKey];
    const idx = arr.findIndex((e) => e.instanceId === exec.instanceId);
    if (idx >= 0) arr[idx] = exec; else arr.push(exec);

    // Recompute daily summary (do NOT equate totalTasks with completed)
    const totalMinutes = minutesFromEntries(arr);
    // completed = unique tasks completed on the day
    const completedSet = new Set<string>();
    for (const entry of arr) {
      if (isEntryCompleted(entry)) {
        completedSet.add(computeExecutionInstanceKey(entry));
      }
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

    if (!file) {
      return;
    }
    await this.plugin.app.vault.modify(file, JSON.stringify(json, null, 2));
  }

  async removeTaskLogForInstanceOnDate(instanceId: string, dateKey: string): Promise<void> {
    try {
      const [y, m] = dateKey.split('-');
      const monthKey = `${y}-${m}`;
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const logPath = `${logDataPath}/${monthKey}-tasks.json`;

      const maybeFile = this.plugin.app.vault.getAbstractFileByPath(logPath);
      if (!maybeFile || !(maybeFile instanceof TFile)) return;

      const raw = await this.plugin.app.vault.read(maybeFile);
      if (!raw) return;

      const json = parseLogFile(raw);
      const dayEntries = json.taskExecutions[dateKey];
      if (!Array.isArray(dayEntries)) return;

      const filtered = dayEntries.filter((entry) => entry.instanceId !== instanceId);
      json.taskExecutions[dateKey] = filtered;

      const totalMinutes = minutesFromEntries(filtered);
      const completedSet = new Set<string>();
      for (const entry of filtered) {
        if (isEntryCompleted(entry)) {
          completedSet.add(computeExecutionInstanceKey(entry));
        }
      }
      const completedTasks = completedSet.size;
      const prev = json.dailySummary[dateKey] ?? {};
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

      await this.plugin.app.vault.modify(maybeFile, JSON.stringify(json, null, 2));
    } catch (error) {
      console.warn('[ExecutionLogService] Failed to remove task log entry', error);
    }
  }
}
