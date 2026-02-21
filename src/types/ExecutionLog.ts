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
  totalTasksRecordedAt?: string
  totalTasksDeviceId?: string
  totalTasksEntryId?: string
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
  cursorSnapshotRevision?: Record<string, number>
  lastBackupAt?: string
  [key: string]: unknown
}

// Sync Conflict Prevention Error Types

/**
 * スナップショット書き込み時のrevision競合エラー
 * 他のデバイスが先にスナップショットを更新していた場合に発生
 */
export class SnapshotConflictError extends Error {
  constructor(public currentSnapshot: TaskLogSnapshot) {
    super('Snapshot conflict detected')
    this.name = 'SnapshotConflictError'
  }
}

/**
 * スナップショットのJSON破損エラー
 * ファイルが部分書き込みや破損により読み込めない場合に発生
 */
export class SnapshotCorruptedError extends Error {
  constructor(public path: string) {
    super(`Snapshot corrupted: ${path}`)
    this.name = 'SnapshotCorruptedError'
  }
}

/**
 * 旧形式（meta未設定）のスナップショットエラー
 * マイグレーションが必要な場合に発生
 */
export class LegacySnapshotError extends Error {
  constructor(
    public path: string,
    public legacySnapshot: TaskLogSnapshot
  ) {
    super(`Legacy snapshot requires migration: ${path}`)
    this.name = 'LegacySnapshotError'
  }
}
