import type { TaskLogEntry, TaskLogSnapshot } from '../types/ExecutionLog'

export const EMPTY_TASK_LOG_SNAPSHOT: TaskLogSnapshot = {
  taskExecutions: {},
  dailySummary: {},
}

export function createEmptyTaskLogSnapshot(): TaskLogSnapshot {
  return {
    taskExecutions: {},
    dailySummary: {},
  }
}

export function parseTaskLogSnapshot(raw: string | null | undefined): TaskLogSnapshot {
  if (!raw || typeof raw !== 'string') {
    return createEmptyTaskLogSnapshot()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TaskLogSnapshot>
    return {
      taskExecutions: parsed.taskExecutions ?? {},
      dailySummary: parsed.dailySummary ?? {},
      ...parsed,
    }
  } catch (error) {
    console.warn('[executionLogUtils] Failed to parse task log snapshot', error)
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
