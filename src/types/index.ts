import type { Command, Plugin } from "obsidian"
import { TFile } from "obsidian"
import type { PathService } from "../services/PathService"

// Re-export new typed fields
export * from "./TaskFields"
export * from "./projectBoard"

export type LocationMode = "vaultRoot" | "specifiedFolder"

export interface TaskChuteSettings {
  // New storage model (all optional for backward-compat)
  locationMode?: LocationMode // default: 'vaultRoot'
  specifiedFolder?: string // used when locationMode==='specifiedFolder'
  projectsFolder?: string | null // independent; can be unset
  projectTemplatePath?: string | null
  projectTitlePrefix?: string

  // Legacy (kept for migration/compat; UI should not expose)
  taskFolderPath?: string
  projectFolderPath?: string
  logDataPath?: string
  reviewDataPath?: string
  reviewTemplatePath?: string | null
  reviewFileNamePattern?: string

  // General
  useOrderBasedSort: boolean
  slotKeys: Record<string, string>
  languageOverride?: "auto" | "en" | "ja"

  // UI/Features
  aiRobotButtonEnabled?: boolean // default false; show robot button if true
  // Field migration settings
  preferNewFieldFormat?: boolean // Use scheduled_time for new tasks
  autoMigrateOnLoad?: boolean // Auto-migrate old fields when loading

  // Execution log backups
  backupIntervalHours?: number
  backupRetentionDays?: number

  // Reminder settings
  defaultReminderMinutes?: number // default: 5 (used for initial value calculation)

  // Device identity (legacy, migrated to localStorage)
  deviceId?: string

  // Google Calendar export (URL scheme, push-only)
  googleCalendar?: GoogleCalendarSettings
}

export interface GoogleCalendarSettings {
  enabled?: boolean
  defaultDurationMinutes?: number
  includeNoteContent?: boolean
}

export const VIEW_TYPE_TASKCHUTE = "taskchute-view" as const
export const VIEW_TYPE_PROJECT_BOARD = "taskchute-project-board" as const

export type TaskChutePlugin = Plugin & TaskChutePluginAugment

type TaskChutePluginAugment = {
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  routineAliasService: RoutineAliasServiceLike
  dayStateService: DayStateServiceAPI
  saveSettings(): Promise<void>
  showSettingsModal(): void
  addRibbonIcon(
    iconId: string,
    title: string,
    callback: () => void | Promise<void>,
  ): HTMLElement
  addCommand(command: Command): Command
  _log?(level?: string, ...args: unknown[]): void
  _notify?(message: string, timeout?: number): void
}

export type TaskChutePluginLike = Pick<
  TaskChutePlugin,
  | "app"
  | "settings"
  | "pathManager"
  | "routineAliasService"
  | "dayStateService"
  | "saveSettings"
  | "_log"
  | "_notify"
  | "manifest"
> & {
  /** Optional reminder manager for notification scheduling */
  reminderManager?: ReminderManagerLike
}

export interface TaskData {
  file: TFile | null
  frontmatter: Record<string, unknown>
  path: string
  name: string
  displayTitle?: string
  taskId?: string
  startTime?: string
  endTime?: string
  actualMinutes?: number
  status?: "pending" | "in_progress" | "completed"
  project?: string
  projectPath?: string
  projectTitle?: string
  isRoutine?: boolean
  createdMillis?: number
  routine_type?: "daily" | "weekly" | "monthly" | "weekdays" | "weekends"
  routine_start?: string
  routine_end?: string
  weekdays?: number[]
  weekday?: number
  monthly_week?: number | "last"
  monthly_weekday?: number
  // New normalized routine fields
  routine_interval?: number // >=1, default 1
  routine_enabled?: boolean // default true
  // Weekly: single weekday for now (0=Sun)
  routine_weekday?: number
  // Monthly: week index (1..5 or 'last') + weekday
  routine_week?: number | "last"
  routine_weeks?: (number | "last")[]
  routine_weekdays?: number[]
  routine_day?: string
  flexible_schedule?: boolean
  scheduledTime?: string
  title?: string
  // Reminder field (time in HH:mm format when notification should fire)
  reminder_time?: string
  [key: string]: unknown
}

export interface TaskInstance {
  task: TaskData
  instanceId: string
  state: "idle" | "running" | "done" | "paused"
  slotKey: string
  createdMillis?: number
  // Optional: record keeping and display helpers
  executedTitle?: string
  originalSlotKey?: string
  order?: number // For order-based sorting
  positionInSlot?: number // Deprecated - kept for backward compatibility
  startTime?: Date
  stopTime?: Date
  pausedDuration?: number
  actualMinutes?: number
  actualTime?: number
  comment?: string
  focusLevel?: number
  energyLevel?: number
  date?: string
  projectName?: string
}

export interface DeletedInstance {
  instanceId?: string
  path?: string
  deletionType?: "temporary" | "permanent"
  timestamp?: number
  taskId?: string
}

export interface HiddenRoutine {
  path: string
  instanceId?: string | null
}

export interface DuplicatedInstance {
  instanceId: string
  originalPath: string
  timestamp?: number
  createdMillis?: number
  originalTaskId?: string
}

export interface DayState {
  hiddenRoutines: HiddenRoutine[]
  deletedInstances: DeletedInstance[]
  duplicatedInstances: Array<
    DuplicatedInstance & {
      slotKey?: string
      originalSlotKey?: string
    }
  >
  slotOverrides: Record<string, string>
  orders: Record<string, number>
}

export interface MonthlyDayStateFile {
  days: Record<string, DayState>
  metadata: {
    version: string
    lastUpdated: string
  }
}

export type PathManagerLike = Pick<
  PathService,
  | "getTaskFolderPath"
  | "getProjectFolderPath"
  | "getLogDataPath"
  | "getReviewDataPath"
  | "ensureFolderExists"
  | "getLogYearPath"
  | "ensureYearFolder"
  | "validatePath"
>

export interface DayStateServiceAPI {
  loadDay(date: Date): Promise<DayState>
  saveDay(date: Date, state: DayState): Promise<void>
  mergeDayState(date: Date, partial: Partial<DayState>): Promise<void>
  clearCache(): Promise<void>
  getDateFromKey(dateKey: string): Date
  renameTaskPath(oldPath: string, newPath: string): Promise<void>
}

export interface RoutineAliasServiceLike {
  getAllPossibleNames?(title: string): string[]
  loadAliases(): Promise<Record<string, string[]>>
  getAliases?(taskName: string): string[]
  saveAliases?(aliases: Record<string, string[]>): Promise<void>
}

export interface RunningTask {
  taskId: string
  taskName: string
  startTime: string
  elapsedTime: number
  pausedTime?: number
  isPaused?: boolean
  actualMinutes?: number
}

export type LogEntry = Record<string, Record<string, unknown>>

export interface HeatmapData {
  [date: string]: {
    totalMinutes: number
    totalTasks: number
    procrastination?: number
  }
}

// New heatmap structures (aligned with main.js LogView)
export interface HeatmapDayStats {
  totalTasks: number
  completedTasks: number
  procrastinatedTasks: number
  completionRate: number // 0..1
}

export interface HeatmapYearData {
  year: number
  days: Record<string, HeatmapDayStats>
  metadata?: {
    version: string
    lastUpdated?: string
  }
}

export interface HeatmapExecutionDetail {
  id: string
  title: string
  taskPath?: string
  startTime?: string
  stopTime?: string
  durationSec?: number
  focusLevel?: number
  energyLevel?: number
  executionComment?: string
  project?: string
  projectPath?: string
  isCompleted: boolean
}

export interface HeatmapDayDetail {
  date: string
  satisfaction: number | null
  summary: {
    totalTasks: number
    completedTasks: number
    totalMinutes: number
    procrastinatedTasks: number
    completionRate: number
    avgFocusLevel: number | null
    avgEnergyLevel: number | null
  }
  executions: HeatmapExecutionDetail[]
}

export interface NavigationState {
  selectedSection: "routine" | "review" | "log" | "settings" | null
  isOpen: boolean
}

export interface TaskNameValidator {
  INVALID_CHARS_PATTERN: RegExp
  validate(taskName: string): { isValid: boolean; invalidChars: string[] }
  getErrorMessage(invalidChars: string[]): string
}

export interface AutocompleteInstance {
  cleanup?: () => void
  [key: string]: unknown
}

// Routine types are now exported from TaskFields.ts via export *

// Phase 3: Use properly typed frontmatter
// Import from TaskFields module
import type { TaskFrontmatter, RoutineType, RoutineWeek } from "./TaskFields"

export interface RoutineFrontmatter extends TaskFrontmatter {
  // Legacy compatibility - keep the original shape but extend from TaskFrontmatter
  weekday?: number
  monthly_week?: RoutineWeek
  monthly_weekday?: number
}

export interface RoutineRule {
  type: RoutineType
  interval: number // >= 1
  start?: string // YYYY-MM-DD
  end?: string // YYYY-MM-DD
  enabled: boolean // default true
  // weekly
  weekday?: number // 0..6
  weekdaySet?: number[]
  // monthly
  week?: number | "last" // 1..5 | 'last'
  monthWeekday?: number // 0..6
  weekSet?: (number | 'last')[]
  monthWeekdaySet?: number[]
}

/**
 * Interface for ReminderSystemManager that can be used in TaskChuteView
 * to avoid circular dependencies with the full ReminderSystemManager class.
 */
export interface ReminderManagerLike {
  /**
   * Build reminder schedules for today's tasks.
   * Should be called after loading tasks.
   */
  buildTodaySchedules(tasks: unknown[]): void

  /**
   * Called when a task's reminder time is changed via UI.
   * @param taskPath The file path of the task
   * @param newReminderTime The new reminder time in HH:mm format, or null to clear
   * @param taskName Optional task name for creating new schedules
   * @param scheduledTime Optional scheduled time for creating new schedules
   */
  onTaskReminderTimeChanged(
    taskPath: string,
    newReminderTime: string | null,
    taskName?: string,
    scheduledTime?: string
  ): void

  /**
   * Called when a task is completed.
   * Removes the reminder schedule for the task.
   */
  onTaskComplete(taskPath: string): void
}
