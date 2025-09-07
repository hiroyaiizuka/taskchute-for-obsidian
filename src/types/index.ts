import { TFile } from 'obsidian';

export interface TaskChuteSettings {
  taskFolderPath: string;
  projectFolderPath: string;
  logDataPath: string;
  reviewDataPath: string;
  enableSound: boolean;
  enableFireworks: boolean;
  enableConfetti: boolean;
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
  routine_week?: string;
  routine_day?: string;
  flexible_schedule?: boolean;
  [key: string]: any;
}

export interface TaskInstance {
  task: TaskData;
  instanceId: string;
  state: 'idle' | 'running' | 'done' | 'paused';
  slotKey: string;
  manualPosition?: number;
  positionInSlot?: number;
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