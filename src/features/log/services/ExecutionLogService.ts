import { normalizePath, TFile, TFolder } from 'obsidian';
import type { TaskChutePluginLike } from '../../../types';
import type { TaskInstance } from '../../../types';
import { DeviceIdentityService } from '../../../services/DeviceIdentityService';
import {
  createEmptyTaskLogSnapshot,
  parseTaskLogSnapshot,
} from '../../../utils/executionLogUtils';
import type { TaskLogEntry } from '../../../types/ExecutionLog';
import {
  ExecutionLogDeltaWriter,
  type ExecutionLogDeltaOperation,
  type ExecutionLogDeltaPayloadEntry,
  type ExecutionLogDeltaRecord,
} from './ExecutionLogDeltaWriter';
import { RecordsRebuilder, type RecordsRebuildStats } from './RecordsRebuilder';
import { LogReconciler } from './LogReconciler';
import { LOG_INBOX_FOLDER, LOG_INBOX_LEGACY_FOLDER } from '../constants';

export class ExecutionLogService {
  private readonly deviceIdentity: DeviceIdentityService;
  private readonly deltaWriter: ExecutionLogDeltaWriter;
  private readonly logReconciler: LogReconciler;
  private readonly recordsRebuilder: RecordsRebuilder;
  private reconcilePromise: Promise<void> | null = null;
  private reconcilePending = false;
  private readonly summaryDeltaCache = new Map<string, number>();

  constructor(private plugin: TaskChutePluginLike) {
    this.deviceIdentity = new DeviceIdentityService(plugin);
    this.deltaWriter = new ExecutionLogDeltaWriter(plugin, this.deviceIdentity);
    this.logReconciler = new LogReconciler(plugin);
    this.recordsRebuilder = new RecordsRebuilder(plugin);
    this.enqueueReconcile();
  }

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
    return 'Untitled task';
  }

  async saveTaskLog(inst: TaskInstance, durationSec: number): Promise<void> {
    if (!inst.startTime || !inst.stopTime) return;
    const deviceId = await this.deviceIdentity.getOrCreateDeviceId();
    const start = new Date(inst.startTime);
    const monthKey = this.getMonthKey(start);
    const dateKey = this.getDateKey(start);

    const exec: TaskLogEntry = {
      taskTitle: this.resolveTaskTitle(inst),
      taskPath: inst.task.path,
      taskId: inst.task.taskId,
      instanceId: inst.instanceId,
      slotKey: inst.slotKey,
      startTime: this.toHMS(start),
      stopTime: this.toHMS(inst.stopTime),
      durationSec,
      deviceId,
    };

    await this.appendDeltaRecord({ monthKey, dateKey, entry: exec });
    this.enqueueReconcile();
  }

  async appendCommentDelta(dateKey: string, entry: TaskLogEntry): Promise<void> {
    if (!dateKey || typeof dateKey !== 'string') {
      return;
    }
    const [year, month] = dateKey.split('-');
    if (!year || !month) {
      return;
    }
    const monthKey = `${year}-${month}`;
    await this.appendDeltaRecord({ monthKey, dateKey, entry, operation: 'upsert' });
    this.enqueueReconcile();
  }

  async rebuildFromRecords(): Promise<RecordsRebuildStats> {
    const stats = await this.recordsRebuilder.rebuildAllFromRecords();
    await this.ensureReconciled();
    return stats;
  }

  async removeTaskLogForInstanceOnDate(
    instanceId: string,
    dateKey: string,
    taskId?: string,
    taskPath?: string,
  ): Promise<void> {
    if (!instanceId && !taskId) {
      return
    }
    try {
      const [y, m] = dateKey.split('-')
      const monthKey = `${y}-${m}`
      const entry: TaskLogEntry = {}
      if (instanceId) {
        entry.instanceId = instanceId
      }
      if (taskId) {
        entry.taskId = taskId
      }
      if (taskPath) {
        entry.taskPath = taskPath
      }

      await this.appendDeltaRecord({
        monthKey,
        dateKey,
        entry,
        operation: 'delete',
      })
      this.enqueueReconcile()
    } catch (error) {
      console.warn('[ExecutionLogService] Failed to remove task log entry', error)
    }
  }

  async renameTaskPath(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = typeof oldPath === 'string' ? oldPath.trim() : '';
    const normalizedNew = typeof newPath === 'string' ? newPath.trim() : '';
    if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
      return;
    }

    const files = this.collectLogFiles();
    let appended = 0;
    const renamedKeys = new Set<string>();
    const appendRename = async (dateKey: string, entry: TaskLogEntry): Promise<void> => {
      if (!dateKey || typeof dateKey !== 'string') {
        return;
      }
      if (!entry || typeof entry !== 'object') {
        return;
      }
      if (entry.taskPath !== normalizedOld) {
        return;
      }
      if (entry.taskPath === normalizedNew) {
        return;
      }
      const key = this.buildRenameKey(dateKey, entry);
      if (renamedKeys.has(key)) {
        return;
      }
      const monthKey = dateKey.slice(0, 7);
      const updatedEntry: TaskLogEntry = {
        ...entry,
        taskPath: normalizedNew,
      };
      await this.appendDeltaRecord({
        monthKey,
        dateKey,
        entry: updatedEntry,
        operation: 'upsert',
      });
      renamedKeys.add(key);
      appended += 1;
    };
    for (const file of files) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        const snapshot = raw ? parseTaskLogSnapshot(raw) : createEmptyTaskLogSnapshot();

        for (const [dateKey, entries] of Object.entries(snapshot.taskExecutions)) {
          if (!Array.isArray(entries) || entries.length === 0) {
            continue;
          }
          for (const entry of entries) {
            await appendRename(dateKey, entry);
          }
        }
      } catch (error) {
        console.warn('[ExecutionLogService] Failed to rename task path in log', file.path, error);
      }
    }

    const deltaFiles = await this.collectDeltaFiles();
    for (const deltaPath of deltaFiles) {
      const records = await this.readDeltaRecords(deltaPath);
      for (const record of records) {
        const op = record.op ?? 'upsert';
        if (op !== 'upsert') {
          continue;
        }
        if (!record.dateKey || typeof record.dateKey !== 'string') {
          continue;
        }
        const payload = record.payload;
        if (!payload || typeof payload !== 'object') {
          continue;
        }
        await appendRename(record.dateKey, payload as TaskLogEntry);
      }
    }

    if (appended > 0) {
      this.enqueueReconcile();
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
    if (!Number.isFinite(totalTasks)) {
      return;
    }

    const cached = this.summaryDeltaCache.get(dateKey);
    if (cached === totalTasks) {
      return;
    }
    this.summaryDeltaCache.set(dateKey, totalTasks);

    const monthKey = `${year}-${month}`;
    await this.appendDeltaRecord({
      monthKey,
      dateKey,
      entry: { summary: { totalTasks } },
      operation: 'summary',
    });
    this.enqueueReconcile();
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

  private async collectDeltaFiles(): Promise<string[]> {
    const logBase = this.plugin.pathManager.getLogDataPath();
    const inboxPaths = [
      normalizePath(`${logBase}/${LOG_INBOX_FOLDER}`),
      normalizePath(`${logBase}/${LOG_INBOX_LEGACY_FOLDER}`),
    ];
    const files = new Set<string>();

    for (const inboxPath of inboxPaths) {
      const root = this.plugin.app.vault.getAbstractFileByPath(inboxPath);
      if (!root || !(root instanceof TFolder)) {
        continue;
      }
      for (const deviceFolder of root.children) {
        if (!(deviceFolder instanceof TFolder)) continue;
        for (const child of deviceFolder.children) {
          if (!(child instanceof TFile)) continue;
          if (!child.path.endsWith('.jsonl')) continue;
          files.add(child.path);
        }
      }
    }

    const adapter = this.plugin.app.vault.adapter as
      | { list?: (path: string) => Promise<{ files: string[]; folders: string[] }> }
      | undefined;
    if (adapter && typeof adapter.list === 'function') {
      for (const inboxPath of inboxPaths) {
        try {
          const listing = await adapter.list(inboxPath);
          const folders = listing.folders ?? [];
          for (const folder of folders) {
            try {
              const inner = await adapter.list(folder);
              const innerFiles = inner.files ?? [];
              for (const filePath of innerFiles) {
                if (filePath.endsWith('.jsonl')) {
                  files.add(filePath);
                }
              }
            } catch (error) {
              console.warn('[ExecutionLogService] Failed to list delta device folder', folder, error);
            }
          }
        } catch (error) {
          console.warn('[ExecutionLogService] Failed to list delta inbox', inboxPath, error);
        }
      }
    }

    return Array.from(files);
  }

  private async readDeltaRecords(path: string): Promise<ExecutionLogDeltaRecord[]> {
    const adapter = this.plugin.app.vault.adapter as
      | { read?: (path: string) => Promise<string> }
      | undefined;
    if (!adapter || typeof adapter.read !== 'function') {
      return [];
    }
    try {
      const content = await adapter.read(path);
      if (!content) {
        return [];
      }
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const records: ExecutionLogDeltaRecord[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ExecutionLogDeltaRecord;
          records.push(parsed);
        } catch (error) {
          console.warn('[ExecutionLogService] Failed to parse delta line', path, error);
        }
      }
      return records;
    } catch (error) {
      console.warn('[ExecutionLogService] Failed to read delta file', path, error);
      return [];
    }
  }

  private buildRenameKey(dateKey: string, entry: TaskLogEntry): string {
    const instanceId = typeof entry.instanceId === 'string' ? entry.instanceId : '';
    if (instanceId) {
      return `${dateKey}::instance::${instanceId}`;
    }
    const taskId = typeof entry.taskId === 'string' ? entry.taskId : '';
    const startTime = typeof entry.startTime === 'string' ? entry.startTime : '';
    const stopTime = typeof entry.stopTime === 'string' ? entry.stopTime : '';
    const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : '';
    if (taskId && (startTime || stopTime || recordedAt)) {
      return `${dateKey}::task::${taskId}::${startTime}::${stopTime}::${recordedAt}`;
    }
    const title = typeof entry.taskTitle === 'string' ? entry.taskTitle : '';
    if (title) {
      return `${dateKey}::title::${title}`;
    }
    return `${dateKey}::payload::${JSON.stringify(entry)}`;
  }

  private async appendDeltaRecord(payload: {
    monthKey: string;
    dateKey: string;
    entry: ExecutionLogDeltaPayloadEntry;
    operation?: ExecutionLogDeltaOperation;
  }): Promise<void> {
    try {
      await this.deltaWriter.appendEntry({
        monthKey: payload.monthKey,
        dateKey: payload.dateKey,
        entry: payload.entry,
        operation: payload.operation,
      });
    } catch (error) {
      console.warn('[ExecutionLogService] Failed to append delta record', error);
    }
  }

  private enqueueReconcile(): void {
    if (this.reconcilePromise) {
      this.reconcilePending = true;
      return;
    }
    this.reconcilePromise = this.logReconciler
      .reconcilePendingDeltas()
      .then(() => { /* return void */ })
      .catch((error) => {
        console.warn('[ExecutionLogService] Failed to reconcile logs', error);
      })
      .finally(() => {
        this.reconcilePromise = null;
        if (this.reconcilePending) {
          this.reconcilePending = false;
          this.enqueueReconcile();
        }
      });
  }

  async ensureReconciled(): Promise<void> {
    if (!this.reconcilePromise) {
      this.enqueueReconcile();
      if (!this.reconcilePromise) {
        return;
      }
    }
    try {
      await this.reconcilePromise;
    } catch {
      // already logged in enqueueReconcile
    }
  }
}
