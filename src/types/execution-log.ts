export interface TaskLogEntry {
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
  [key: string]: unknown
}
