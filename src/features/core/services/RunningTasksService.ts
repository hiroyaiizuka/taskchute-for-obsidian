import { TFile } from 'obsidian'
import type {
  DeletedInstance,
  HiddenRoutine,
  TaskChutePluginLike,
  TaskData,
  TaskInstance,
} from '../../../types'
import { extractTaskIdFromFrontmatter } from '../../../services/TaskIdManager'
import { isDeleted as isDeletedEntry, isHidden as isHiddenEntry, isLegacyDeletionEntry } from '../../../services/dayState/conflictResolver'
import { getCurrentTimeSlot } from '../../../utils/time'
import type { SectionConfigService } from '../../../services/SectionConfigService'
import { normalizeReminderTime } from '../../reminder/services/ReminderFrontmatterService'

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

/**
 * Every mounted TaskChute view owns a RunningTasksService instance, but they
 * share one vault file. Serialize read-modify-write mutations by adapter/path
 * so recovery in two leaves cannot overwrite each other's result.
 */
const runningTaskMutationTails = new WeakMap<
  object,
  Map<string, Promise<void>>
>()

async function serializeRunningTaskMutation<T>(
  adapter: object,
  dataPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  let byPath = runningTaskMutationTails.get(adapter)
  if (!byPath) {
    byPath = new Map()
    runningTaskMutationTails.set(adapter, byPath)
  }
  const previous = byPath.get(dataPath) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  byPath.set(dataPath, tail)
  try {
    return await run
  } finally {
    if (byPath.get(dataPath) === tail) byPath.delete(dataPath)
  }
}

export class RunningTasksService {
  private sectionConfig: SectionConfigService | null = null

  constructor(private plugin: TaskChutePluginLike) {}

  setSectionConfig(config: SectionConfigService): void {
    this.sectionConfig = config
  }

  getSectionConfig(): SectionConfigService | null {
    return this.sectionConfig
  }

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

  async save(runningInstances: TaskInstance[], viewDateString?: string): Promise<void> {
    const records: RunningTaskRecord[] = runningInstances.map((inst) => {
      const base = inst.startTime ? new Date(inst.startTime) : new Date();
      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      const d = String(base.getDate()).padStart(2, '0');
      // A task can keep yesterday's startTime after it is explicitly moved to
      // today's board. The board date is authoritative when the caller
      // supplies it; otherwise a later save would silently move the persisted
      // record back to the start date.
      const dateString = viewDateString ?? `${y}-${m}-${d}`;
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

    const datesToReplace = new Set(records.map((r) => r.date));
    if (viewDateString) datesToReplace.add(viewDateString);

    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const dataPath = `${logDataPath}/running-task.json`;

    const adapter = this.plugin.app.vault.adapter;
    await serializeRunningTaskMutation(adapter, dataPath, async () => {
      // Read existing records
      let existing: RunningTaskRecord[] = [];
      try {
        if (await adapter.exists(dataPath)) {
          const raw = await adapter.read(dataPath);
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            existing = parsed.filter(
              (entry): entry is RunningTaskRecord => this.isRunningTaskRecord(entry),
            );
          }
        }
      } catch {
        // If read fails, start fresh
      }

      // Preserve records for other dates
      const preserved = existing.filter((r) => !datesToReplace.has(r.date));
      const merged = [...preserved, ...records];

      await adapter.write(dataPath, JSON.stringify(merged, null, 2));
    })
  }

  async deleteByInstanceOrPath(options: {
    instanceId?: string
    taskPath?: string
    taskId?: string
  }): Promise<number> {
    try {
      return await this.deleteByInstanceOrPathStrict(options)
    } catch (error) {
      console.warn('[RunningTasksService] Failed to delete running task record', error);
      return 0;
    }
  }

  /**
   * Move persisted running-task records to another board date.
   *
   * This is a strict storage boundary:
   * - a missing file or unmatched selector returns 0;
   * - malformed JSON / an invalid top-level value rejects;
   * - write failures reject.
   *
   * An instanceId, when supplied, is always the selector. This deliberately
   * avoids falling back to taskId/path and moving a sibling duplicate.
   */
  async moveRunningTaskToDateStrict(options: {
    targetDate: string
    instanceId?: string
    taskPath?: string
    taskId?: string
  }): Promise<number> {
    const { targetDate, instanceId, taskPath, taskId } = options
    if (!this.isValidDateKey(targetDate)) {
      throw new TypeError(`Invalid running-task target date: ${targetDate}`)
    }
    if (!instanceId && !taskPath && !taskId) return 0

    const logDataPath = this.plugin.pathManager.getLogDataPath()
    const dataPath = `${logDataPath}/running-task.json`
    const adapter = this.plugin.app.vault.adapter

    return await serializeRunningTaskMutation(adapter, dataPath, async () => {
      if (!(await adapter.exists(dataPath))) return 0
      const raw = await adapter.read(dataPath)
      if (!raw) return 0

      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        throw new TypeError('running-task.json must contain an array')
      }

      const matches = (record: RunningTaskRecord): boolean => {
        if (instanceId) return record.instanceId === instanceId
        if (taskId) return record.taskId === taskId
        return record.taskPath === taskPath
      }

      let moved = 0
      const entries: unknown[] = parsed
      const updated = entries.map((entry): unknown => {
        if (
          !this.isRunningTaskRecord(entry) ||
          !matches(entry) ||
          entry.date === targetDate
        ) {
          return entry
        }
        moved += 1
        return { ...entry, date: targetDate }
      })

      if (moved === 0) return 0
      await adapter.write(dataPath, JSON.stringify(updated, null, 2))
      return moved
    })
  }

  /**
   * Strict recovery boundary: unlike the public best-effort wrapper, storage
   * failures reject so the caller can roll back in-memory state and retry.
   */
  async deleteByInstanceOrPathStrict(options: {
    instanceId?: string
    taskPath?: string
    taskId?: string
  }): Promise<number> {
    const { instanceId, taskPath, taskId } = options
    if (!instanceId && !taskPath && !taskId) return 0

    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const dataPath = `${logDataPath}/running-task.json`;
    const adapter = this.plugin.app.vault.adapter;
    return await serializeRunningTaskMutation(adapter, dataPath, async () => {
      if (!(await adapter.exists(dataPath))) return 0
      const raw = await adapter.read(dataPath)
      if (!raw) return 0
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return 0

      const records = parsed.filter(
        (entry): entry is RunningTaskRecord => this.isRunningTaskRecord(entry),
      )
      let filtered = records
      if (instanceId) {
        filtered = records.filter((record) => record.instanceId !== instanceId)
      } else if (taskId) {
        filtered = records.filter((record) => record.taskId !== taskId)
      } else if (taskPath) {
        filtered = records.filter((record) => record.taskPath !== taskPath)
      }
      if (filtered.length === records.length) return 0

      await adapter.write(dataPath, JSON.stringify(filtered, null, 2))
      return records.length - filtered.length
    })
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
      const adapter = this.plugin.app.vault.adapter;
      await serializeRunningTaskMutation(adapter, dataPath, async () => {
        if (!(await adapter.exists(dataPath))) {
          return;
        }

        const raw = await adapter.read(dataPath);
        if (!raw) {
          return;
        }

        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return;
        }

        let mutated = false;
        const updated = (parsed as unknown[]).map((entry) => {
          if (!this.isRunningTaskRecord(entry)) {
            return entry;
          }
          if (entry.taskPath === normalizedOld) {
            mutated = true;
            const next: RunningTaskRecord = { ...entry, taskPath: normalizedNew };
            if (options.newTitle && typeof options.newTitle === 'string' && options.newTitle.trim().length > 0) {
              next.taskTitle = options.newTitle.trim();
            }
            return next;
          }
          return entry;
        });

        if (mutated) {
          await adapter.write(dataPath, JSON.stringify(updated, null, 2));
        }
      });
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
    let didMigrateSlotKeys = false
    const hiddenEntries = hiddenRoutines ?? []
    const deletedEntries = deletedInstances ?? []

    const isHiddenRecord = (record: RunningTaskRecord): boolean => {
      const hasVisibleInstance =
        typeof record.instanceId === 'string' &&
        record.instanceId.length > 0 &&
        instances.some((inst) => inst.instanceId === record.instanceId)
      return hiddenEntries.some((entry) => {
        if (!entry) return false
        if (typeof entry === 'string') {
          if (hasVisibleInstance) {
            return false
          }
          return entry === record.taskPath
        }
        if (!isHiddenEntry(entry)) {
          return false
        }
        const entryInstanceId =
          typeof entry.instanceId === 'string' && entry.instanceId.trim().length > 0
            ? entry.instanceId
            : null
        if (entryInstanceId) {
          if (record.instanceId) {
            return entryInstanceId === record.instanceId
          }
          return entry.path === record.taskPath
        }
        if (hasVisibleInstance) {
          return false
        }
        return entry.path === record.taskPath
      })
    }

    const isDeletedRecord = (record: RunningTaskRecord): boolean => {
      return deletedEntries.some((entry) => {
        if (!entry) return false
        if (!isDeletedEntry(entry) && !(entry.deletionType === 'permanent' && isLegacyDeletionEntry(entry))) {
          return false
        }
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

      // Migrate slot keys when section boundaries are customized
      if (this.sectionConfig) {
        if (record.slotKey && !this.sectionConfig.isValidSlotKey(record.slotKey)) {
          // ISO string → Date → getCurrentTimeSlot for local time conversion
          const startDate = new Date(record.startTime)
          record.slotKey = !isNaN(startDate.getTime())
            ? this.sectionConfig.getCurrentTimeSlot(startDate)
            : 'none'
          didMigrateSlotKeys = true
        }
        if (record.originalSlotKey && !this.sectionConfig.isValidSlotKey(record.originalSlotKey)) {
          record.originalSlotKey = undefined
          didMigrateSlotKeys = true
        }
      }

      if (record.taskPath && deletedPaths.includes(record.taskPath)) continue
      if (isHiddenRecord(record)) continue
      if (isDeletedRecord(record)) continue

      let runningInstance = instances.find((inst) => inst.instanceId === record.instanceId)
      // Fallback: match by path (more specific than taskId)
      if (!runningInstance && record.taskPath) {
        runningInstance = instances.find(
          (inst) => inst.task.path === record.taskPath && inst.state === 'idle',
        )
      }
      // Fallback: match by taskId (stable across file renames)
      if (!runningInstance && record.taskId) {
        runningInstance = instances.find(
          (inst) => inst.task.taskId === record.taskId && inst.state === 'idle',
        )
      }

      if (runningInstance) {
        try {
          const desiredSlot = record.slotKey || (this.sectionConfig?.getCurrentTimeSlot(new Date()) ?? getCurrentTimeSlot(new Date()))
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
      const resolvedTask =
        taskData ?? (record.taskPath ? this.resolveTaskDataFromPath(record.taskPath) : undefined)
      if (!resolvedTask) continue

      const recreated: TaskInstance = {
        task: resolvedTask,
        instanceId: record.instanceId || generateInstanceId(resolvedTask),
        state: 'running',
        slotKey: record.slotKey || (this.sectionConfig?.getCurrentTimeSlot(new Date()) ?? getCurrentTimeSlot(new Date())),
        originalSlotKey: record.originalSlotKey,
        startTime: new Date(record.startTime),
        stopTime: undefined,
        createdMillis: resolvedTask.createdMillis,
      }
      instances.push(recreated)
      restoredInstances.push(recreated)
    }

    if (didMigrateSlotKeys) {
      await this.persistRecordsForDate(dateString)
    }

    return restoredInstances
  }

  private async persistRecordsForDate(dateString: string): Promise<void> {
    try {
      const logDataPath = this.plugin.pathManager?.getLogDataPath?.()
      const adapter = this.plugin.app?.vault?.adapter
      if (!logDataPath || !adapter?.exists || !adapter?.read || !adapter?.write) {
        return
      }
      const dataPath = `${logDataPath}/running-task.json`

      await serializeRunningTaskMutation(adapter, dataPath, async () => {
        if (!(await adapter.exists(dataPath))) {
          return
        }

        const raw = await adapter.read(dataPath)
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) {
          return
        }

        let mutated = false
        const updated = (parsed as unknown[]).map((entry) => {
          if (
            !this.isRunningTaskRecord(entry) ||
            entry.date !== dateString ||
            !this.sectionConfig
          ) {
            return entry
          }

          let next = entry
          if (entry.slotKey && !this.sectionConfig.isValidSlotKey(entry.slotKey)) {
            const startDate = new Date(entry.startTime)
            next = {
              ...next,
              slotKey: !isNaN(startDate.getTime())
                ? this.sectionConfig.getCurrentTimeSlot(startDate)
                : 'none',
            }
            mutated = true
          }
          if (
            entry.originalSlotKey &&
            !this.sectionConfig.isValidSlotKey(entry.originalSlotKey)
          ) {
            next = { ...next, originalSlotKey: undefined }
            mutated = true
          }
          return next
        })

        if (mutated) {
          await adapter.write(dataPath, JSON.stringify(updated, null, 2))
        }
      })
    } catch (error) {
      console.warn('[RunningTasksService] Failed to persist migrated running-task records', error)
    }
  }

  private resolveTaskDataFromPath(path: string): TaskData | undefined {
    if (!path) return undefined
    const app = this.plugin?.app
    if (!app?.vault || !app.metadataCache) {
      return undefined
    }

    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      return undefined
    }

    const cache = app.metadataCache.getFileCache(file)
    const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>
    const title = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
    const displayTitle = title.length > 0 ? title : file.basename

    return {
      file,
      frontmatter,
      path: file.path,
      name: file.basename,
      displayTitle,
      isRoutine: frontmatter.isRoutine === true,
      taskId: extractTaskIdFromFrontmatter(frontmatter),
      reminder_time: normalizeReminderTime(frontmatter.reminder_time),
    }
  }

  private isValidDateKey(value: string): boolean {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
    if (!match) return false
    const [, yearText, monthText, dayText] = match
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    const date = new Date(year, month - 1, day)
    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    )
  }
}
