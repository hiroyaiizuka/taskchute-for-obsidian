export interface ExecutionKeySource {
  taskId?: unknown
  taskPath?: unknown
  taskName?: unknown
  taskTitle?: unknown
  instanceId?: unknown
  startTime?: unknown
  stopTime?: unknown
  [key: string]: unknown
}

const toStringOrNull = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return null
}

/**
 * Returns a stable key representing a unique task execution instance.
 * Prefers instanceId when available so duplicated tasks are not merged.
 */
export const computeExecutionInstanceKey = (entry: ExecutionKeySource): string => {
  const instanceId = toStringOrNull(entry.instanceId)
  if (instanceId) {
    return instanceId
  }

  const taskId = toStringOrNull(entry.taskId)
  if (taskId) {
    const start = toStringOrNull(entry.startTime)
    const stop = toStringOrNull(entry.stopTime)
    if (start && stop) {
      return `${taskId}::${start}-${stop}`
    }
    return taskId
  }

  const base =
    toStringOrNull(entry.taskPath) ??
    toStringOrNull(entry.taskName) ??
    toStringOrNull(entry.taskTitle)

  if (base) {
    const start = toStringOrNull(entry.startTime)
    const stop = toStringOrNull(entry.stopTime)
    if (start && stop) {
      return `${base}::${start}-${stop}`
    }
    return base
  }

  const start = toStringOrNull(entry.startTime)
  const stop = toStringOrNull(entry.stopTime)
  if (start && stop) {
    return `${start}-${stop}`
  }

  return JSON.stringify(entry ?? {})
}
