// Execution log sync redesign introduces delta metadata (entryId/deviceId/recordedAt).
// Additional fields (e.g., deltaRevision) can be added later if reconciliation requires it.
export interface TaskLogEntry {
  entryId?: string
  deviceId?: string
  recordedAt?: string
  taskId?: string
  taskTitle?: string
  taskName?: string
  taskPath?: string
  instanceId?: string
  slotKey?: string
  startTime?: string
  stopTime?: string
  durationSec?: number
  duration?: number
  isCompleted?: boolean
  executionComment?: string
  focusLevel?: number
  energyLevel?: number
  [key: string]: unknown
}

export interface DailySummaryEntry {
  totalMinutes?: number
  totalTasks?: number
  completedTasks?: number
  procrastinatedTasks?: number
  completionRate?: number
  [key: string]: unknown
}

export interface TaskLogSnapshot {
  taskExecutions: Record<string, TaskLogEntry[]>
  dailySummary: Record<string, DailySummaryEntry>
  totalTasks?: number
  meta?: TaskLogSnapshotMeta
  [key: string]: unknown
}

export interface TaskLogSnapshotMeta {
  revision?: number
  lastProcessedAt?: string
  processedCursor?: Record<string, number>
  lastBackupAt?: string
  [key: string]: unknown
}
