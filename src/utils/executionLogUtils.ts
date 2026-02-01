import type { TaskLogEntry, TaskLogSnapshot, TaskLogSnapshotMeta } from '../types/ExecutionLog'

export const EMPTY_TASK_LOG_SNAPSHOT: TaskLogSnapshot = {
  taskExecutions: {},
  dailySummary: {},
  meta: {
    revision: 0,
    processedCursor: {},
    lastBackupAt: undefined,
  },
}

export function createEmptyTaskLogSnapshot(): TaskLogSnapshot {
  return {
    taskExecutions: {},
    dailySummary: {},
    meta: {
      revision: 0,
      processedCursor: {},
      lastBackupAt: undefined,
    },
  }
}

export interface ParseTaskLogSnapshotOptions {
  /** If true, throws an error on parse failure instead of returning empty snapshot */
  throwOnError?: boolean
}

export function parseTaskLogSnapshot(
  raw: string | null | undefined,
  options?: ParseTaskLogSnapshotOptions,
): TaskLogSnapshot {
  if (!raw || typeof raw !== 'string') {
    return createEmptyTaskLogSnapshot()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TaskLogSnapshot>
    const meta: TaskLogSnapshotMeta = {
      revision: typeof parsed.meta?.revision === 'number' ? parsed.meta.revision : 0,
      lastProcessedAt: typeof parsed.meta?.lastProcessedAt === 'string' ? parsed.meta.lastProcessedAt : undefined,
      processedCursor: parsed.meta?.processedCursor && typeof parsed.meta.processedCursor === 'object'
        ? { ...parsed.meta.processedCursor }
        : {},
      lastBackupAt: typeof parsed.meta?.lastBackupAt === 'string' ? parsed.meta.lastBackupAt : undefined,
    }

    return {
      ...parsed,
      taskExecutions: parsed.taskExecutions ?? {},
      dailySummary: parsed.dailySummary ?? {},
      meta,
    }
  } catch (error) {
    console.warn('[executionLogUtils] Failed to parse task log snapshot', error)
    if (options?.throwOnError) {
      throw error // Allow caller to handle and prevent data loss
    }
    return createEmptyTaskLogSnapshot()
  }
}

export function isExecutionLogEntryCompleted(entry: TaskLogEntry): boolean {
  if (typeof entry.isCompleted === 'boolean') {
    return entry.isCompleted
  }
  if (entry.stopTime && typeof entry.stopTime === 'string' && entry.stopTime.trim().length > 0) {
    return true
  }
  if (typeof entry.durationSec === 'number' && entry.durationSec > 0) {
    return true
  }
  if (typeof entry.duration === 'number' && entry.duration > 0) {
    return true
  }
  return true
}

export function minutesFromLogEntries(entries: TaskLogEntry[]): number {
  return entries.reduce((sum, entry) => {
    const duration = entry.durationSec ?? entry.duration ?? 0
    return sum + Math.floor(duration / 60)
  }, 0)
}
