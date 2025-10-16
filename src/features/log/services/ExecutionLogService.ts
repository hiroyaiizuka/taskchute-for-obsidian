import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../../../types';
import type { TaskInstance } from '../../../types';
import { computeExecutionInstanceKey } from '../../../utils/logKeys';
import {
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
  parseTaskLogSnapshot,
} from '../../../utils/executionLogUtils';
import type { TaskLogEntry, TaskLogSnapshot } from '../../../types/ExecutionLog';

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

  private resolveTaskTitle(inst: TaskInstance): string {
    const candidates = [inst.executedTitle, inst.task.displayTitle, inst.task.name];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
    return 'Untitled Task';
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
    let json: TaskLogSnapshot = createEmptyTaskLogSnapshot();
    if (file && file instanceof TFile) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        json = parseTaskLogSnapshot(raw);
      } catch (error) {
        console.warn("[ExecutionLogService] Failed to read log file", error);
        json = createEmptyTaskLogSnapshot();
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

    const exec: TaskLogEntry = {
      taskTitle: this.resolveTaskTitle(inst),
      taskPath: inst.task.path,
      instanceId: inst.instanceId,
      slotKey: inst.slotKey,
      startTime: this.toHMS(start),
      stopTime: this.toHMS(inst.stopTime!),
      durationSec,
    };

    const arr: TaskLogEntry[] = json.taskExecutions[dateKey];
    const idx = arr.findIndex((e) => e.instanceId === exec.instanceId);
    if (idx >= 0) arr[idx] = exec; else arr.push(exec);

    // Recompute daily summary (do NOT equate totalTasks with completed)
    const totalMinutes = minutesFromLogEntries(arr);
    // completed = unique tasks completed on the day
    const completedSet = new Set<string>();
    for (const entry of arr) {
      if (isExecutionLogEntryCompleted(entry)) {
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

      const json = parseTaskLogSnapshot(raw);
      const dayEntries = json.taskExecutions[dateKey];
      if (!Array.isArray(dayEntries)) return;

      const filtered = dayEntries.filter((entry) => entry.instanceId !== instanceId);
      json.taskExecutions[dateKey] = filtered;

      const totalMinutes = minutesFromLogEntries(filtered);
      const completedSet = new Set<string>();
      for (const entry of filtered) {
        if (isExecutionLogEntryCompleted(entry)) {
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

  async renameTaskPath(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = typeof oldPath === 'string' ? oldPath.trim() : '';
    const normalizedNew = typeof newPath === 'string' ? newPath.trim() : '';
    if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
      return;
    }

    const files = this.collectLogFiles();
    for (const file of files) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        const snapshot = raw ? parseTaskLogSnapshot(raw) : createEmptyTaskLogSnapshot();
        let mutated = false;

        for (const [dateKey, entries] of Object.entries(snapshot.taskExecutions)) {
          if (!Array.isArray(entries) || entries.length === 0) {
            continue;
          }
          const updated = entries.map((entry) => {
            if (!entry || typeof entry !== 'object') {
              return entry;
            }
            if ('taskPath' in entry && entry.taskPath === normalizedOld) {
              mutated = true;
              return { ...entry, taskPath: normalizedNew };
            }
            return entry;
          });
          snapshot.taskExecutions[dateKey] = updated as typeof entries;
        }

        if (mutated) {
          await this.plugin.app.vault.modify(file, JSON.stringify(snapshot, null, 2));
        }
      } catch (error) {
        console.warn('[ExecutionLogService] Failed to rename task path in log', file.path, error);
      }
    }
  }

  async hasExecutionHistory(taskPath: string): Promise<boolean> {
    if (!taskPath || !taskPath.trim()) {
      return false;
    }
    const normalized = taskPath.trim();
    const files = this.collectLogFiles();
    for (const file of files) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        if (!raw) {
          continue;
        }
        const snapshot = parseTaskLogSnapshot(raw);
        const days = Object.values(snapshot.taskExecutions);
        const hasMatch = days.some((entries) =>
          Array.isArray(entries) &&
          entries.some((entry) =>
            entry && typeof entry === 'object' && 'taskPath' in entry && entry.taskPath === normalized,
          ),
        );
        if (hasMatch) {
          return true;
        }
      } catch (error) {
        console.warn('[ExecutionLogService] Failed to inspect log file', file.path, error);
      }
    }
    return false;
  }

  async updateDailySummaryTotals(dateKey: string, totalTasks: number): Promise<void> {
    if (!dateKey || typeof dateKey !== 'string') {
      return;
    }
    const [year, month] = dateKey.split('-');
    if (!year || !month) {
      return;
    }

    const monthKey = `${year}-${month}`;
    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const logPath = `${logDataPath}/${monthKey}-tasks.json`;
    const abstract = this.plugin.app.vault.getAbstractFileByPath(logPath);
    let file = abstract instanceof TFile ? abstract : null;

    let snapshot: TaskLogSnapshot = createEmptyTaskLogSnapshot();
    if (file) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        snapshot = parseTaskLogSnapshot(raw);
      } catch (error) {
        console.warn('[ExecutionLogService] Failed to update summary (read error)', error);
      }
    } else {
      await this.plugin.pathManager.ensureFolderExists(logDataPath);
    }

    const dayExecutions = snapshot.taskExecutions[dateKey] ?? [];
    snapshot.taskExecutions[dateKey] = dayExecutions;

    const completedSet = new Set<string>();
    for (const entry of dayExecutions) {
      if (isExecutionLogEntryCompleted(entry)) {
        completedSet.add(computeExecutionInstanceKey(entry));
      }
    }

    const completedTasks = completedSet.size;
    const totalMinutes = minutesFromLogEntries(dayExecutions);
    const procrastinatedTasks = Math.max(0, totalTasks - completedTasks);
    const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;

    const prev = snapshot.dailySummary[dateKey] ?? {};
    snapshot.dailySummary[dateKey] = {
      ...prev,
      totalMinutes,
      totalTasks,
      completedTasks,
      procrastinatedTasks,
      completionRate,
    };

    const payload = JSON.stringify(snapshot, null, 2);
    if (file) {
      await this.plugin.app.vault.modify(file, payload);
    } else {
      await this.plugin.app.vault.create(logPath, payload);
    }
  }

  private collectLogFiles(): TFile[] {
    const logBase = this.plugin.pathManager.getLogDataPath();
    const vault = this.plugin.app.vault as { getFiles?: () => TFile[] };
    const suffix = '-tasks.json';
    const files: TFile[] = [];
    if (typeof vault.getFiles === 'function') {
      const allFiles = vault.getFiles();
      allFiles.forEach((file) => {
        if (file instanceof TFile && file.path.startsWith(`${logBase}/`) && file.path.endsWith(suffix)) {
          files.push(file);
        }
      });
      if (files.length > 0) {
        return files;
      }
    }

    const seen = new Set<string>();
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = this.getMonthKey(date);
      const path = `${logBase}/${monthKey}${suffix}`;
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
      if (abstract && abstract instanceof TFile) {
        files.push(abstract);
      }
    }
    return files;
  }
}
