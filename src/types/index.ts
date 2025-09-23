import { TFile, App } from 'obsidian';

export interface TaskChuteSettings {
  taskFolderPath: string;
  projectFolderPath: string;
  logDataPath: string;
  reviewDataPath: string;
  enableSound: boolean;
  enableFireworks: boolean;
  enableConfetti: boolean;
  useOrderBasedSort: boolean;
  slotKeys: Record<string, string>;
}

export interface TaskData {
  file: TFile;
  frontmatter: any;
  path: string;
  name: string;
  startTime?: string;
  endTime?: string;
  actualMinutes?: number;
  status?: 'pending' | 'in_progress' | 'completed';
  project?: string;
  projectPath?: string;
  projectTitle?: string;
  isRoutine?: boolean;
  routine_type?: 'daily' | 'weekly' | 'monthly' | 'weekdays' | 'weekends';
  routine_start?: string;
  routine_end?: string;
  // New normalized routine fields
  routine_interval?: number; // >=1, default 1
  routine_enabled?: boolean; // default true
  // Weekly: single weekday for now (0=Sun)
  routine_weekday?: number;
  // Monthly: week index (1..5 or 'last') + weekday
  routine_week?: number | 'last';
  routine_day?: string;
  flexible_schedule?: boolean;
  [key: string]: any;
}

export interface TaskInstance {
  task: TaskData;
  instanceId: string;
  state: 'idle' | 'running' | 'done' | 'paused';
  slotKey: string;
  // Optional: record keeping and display helpers
  executedTitle?: string;
  originalSlotKey?: string;
  order?: number;  // For order-based sorting
  positionInSlot?: number;  // Deprecated - kept for backward compatibility
  startTime?: Date;
  stopTime?: Date;
  pausedDuration?: number;
  actualMinutes?: number;
  comment?: string;
  focusLevel?: number;
  energyLevel?: number;
  date?: string;
  projectName?: string;
}

export interface DeletedInstance {
  instanceId?: string;
  path?: string;
  deletionType?: 'temporary' | 'permanent';
  timestamp?: number;
}

export interface HiddenRoutine {
  path: string;
  instanceId?: string | null;
}

export interface DuplicatedInstance {
  instanceId: string;
  originalPath: string;
  timestamp?: number;
}

export interface DayState {
  hiddenRoutines: HiddenRoutine[];
  deletedInstances: DeletedInstance[];
  duplicatedInstances: Array<
    DuplicatedInstance & {
      slotKey?: string;
      originalSlotKey?: string;
    }
  >;
  slotOverrides: Record<string, string>;
  orders: Record<string, number>;
}

export interface MonthlyDayStateFile {
  days: Record<string, DayState>;
  metadata: {
    version: string;
    lastUpdated: string;
  };
}

export interface PathManagerLike {
  getTaskFolderPath(): string;
  getProjectFolderPath(): string;
  getLogDataPath(): string;
  ensureFolderExists(path: string): Promise<void>;
}

export interface DayStateServiceAPI {
  loadDay(date: Date): Promise<DayState>;
  saveDay(date: Date, state: DayState): Promise<void>;
  mergeDayState(date: Date, partial: Partial<DayState>): Promise<void>;
  clearCache(): Promise<void>;
  getDateFromKey(dateKey: string): Date;
}

export interface RoutineAliasManagerLike {
  getAllPossibleNames?(title: string): string[];
  loadAliases(): Promise<void>;
}

export interface TaskChutePluginLike {
  app: App;
  settings: TaskChuteSettings;
  saveSettings(): Promise<void>;
  pathManager: PathManagerLike;
  routineAliasManager: RoutineAliasManagerLike;
  dayStateService: DayStateServiceAPI;
  _log?(level?: string, ...args: any[]): void;
  _notify?(message: string, timeout?: number): void;
  [key: string]: unknown;
}

export interface RunningTask {
  taskId: string;
  taskName: string;
  startTime: string;
  elapsedTime: number;
  pausedTime?: number;
  isPaused?: boolean;
  actualMinutes?: number;
}

export interface LogEntry {
  [date: string]: {
    [taskName: string]: any;
  };
}

export interface HeatmapData {
  [date: string]: {
    totalMinutes: number;
    totalTasks: number;
    procrastination?: number;
  };
}

// New heatmap structures (aligned with main.js LogView)
export interface HeatmapDayStats {
  totalTasks: number;
  completedTasks: number;
  procrastinatedTasks: number;
  completionRate: number; // 0..1
}

export interface HeatmapYearData {
  year: number;
  days: Record<string, HeatmapDayStats>;
  metadata?: {
    version: string;
    lastUpdated?: string;
  };
}

export interface NavigationState {
  selectedSection: 'routine' | 'review' | 'log' | 'project' | null;
  isOpen: boolean;
}

export interface TaskNameValidator {
  INVALID_CHARS_PATTERN: RegExp;
  validate(taskName: string): { isValid: boolean; invalidChars: string[] };
  getErrorMessage(invalidChars: string[]): string;
}

export interface AutocompleteInstance {
  cleanup?: () => void;
  [key: string]: any;
}

// Routine rule (normalized) used by RoutineService
export type RoutineType = 'daily' | 'weekly' | 'monthly';

export interface RoutineRule {
  type: RoutineType;
  interval: number; // >= 1
  start?: string; // YYYY-MM-DD
  end?: string; // YYYY-MM-DD
  enabled: boolean; // default true
  // weekly
  weekday?: number; // 0..6
  // monthly
  week?: number | 'last'; // 1..5 | 'last'
  monthWeekday?: number; // 0..6
}
