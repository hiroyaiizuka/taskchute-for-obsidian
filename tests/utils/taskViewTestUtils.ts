import { loadTasksRefactored } from '../../src/views/TaskChuteView.helpers';
import { DayState, TaskInstance } from '../../src/types';

const { TFile } = require('obsidian');

const DEFAULT_ROUTINE_METADATA = {
  isRoutine: true,
  routine_type: 'daily',
  routine_interval: 1,
  routine_enabled: true,
  routine_start: '2025-09-24',
  開始時刻: '08:00',
};

function createDayState(overrides?: Partial<DayState>): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
    ...overrides,
  } as DayState;
}

function createTFile(path: string) {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
  file.extension = 'md';
  Object.setPrototypeOf(file, TFile.prototype);
  return file;
}

export interface RoutineContextOptions {
  date?: string;
  slotOverride?: string;
  targetDate?: string;
  metadataOverrides?: Record<string, any>;
}

export function createRoutineLoadContext(options: RoutineContextOptions = {}) {
  const {
    date = '2025-09-24',
    slotOverride,
    targetDate,
    metadataOverrides,
  } = options;

  const routinePath = 'TASKS/routine.md';
  const routineFile = {
    path: routinePath,
    basename: 'routine',
    extension: 'md',
  };
  const taskFolder = {
    children: [routineFile],
  };

  const metadata = {
    ...DEFAULT_ROUTINE_METADATA,
    ...(targetDate ? { target_date: targetDate } : {}),
    ...(metadataOverrides ?? {}),
  };

  const slotOverrides = slotOverride ? { [routinePath]: slotOverride } : {};
  const dayState = createDayState({ slotOverrides });

  const plugin = {
    settings: { slotKeys: {} as Record<string, string> },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getLogDataPath: () => 'LOGS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    },
  };

  const ctime = new Date(date).getTime();

  const context: any = {
    plugin,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'TASKS') return taskFolder;
          if (path === routinePath) return routineFile;
          return null;
        }),
        read: jest.fn(async () => '#task'),
        getMarkdownFiles: jest.fn(() => []),
        adapter: {
          stat: jest.fn(async () => ({
            ctime,
            mtime: ctime,
          })),
        },
      },
      metadataCache: {
        getFileCache: jest.fn((file: any) => {
          if (file === routineFile) {
            return { frontmatter: metadata };
          }
          return undefined;
        }),
      },
    },
    tasks: [] as any[],
    taskInstances: [] as TaskInstance[],
    renderTaskList: jest.fn(),
    currentDate: new Date(date),
    getCurrentDateString: () => date,
    ensureDayStateForCurrentDate: jest.fn(),
    getCurrentDayState: jest.fn(() => dayState),
    getDayStateSnapshot: jest.fn(() => dayState),
    getDeletedInstances: jest.fn(() => dayState.deletedInstances),
    isInstanceHidden: jest.fn(() => false),
    isInstanceDeleted: jest.fn(() => false),
    generateInstanceId: jest.fn(() => `routine-${Math.random().toString(36).slice(2)}`),
  };

  return {
    context,
    dayState,
    routinePath,
    routineMetadata: metadata,
    async load() {
      await loadTasksRefactored.call(context);
      return context;
    },
  };
}

export interface NonRoutineContextOptions {
  date?: string;
  deletionType?: 'permanent' | 'temporary' | null;
}

export function createNonRoutineLoadContext(options: NonRoutineContextOptions = {}) {
  const { date = '2025-09-24', deletionType = null } = options;
  const taskPath = 'TASKS/non-routine.md';
  const taskFile = {
    path: taskPath,
    basename: 'non-routine',
    extension: 'md',
  };
  const taskFolder = {
    children: [taskFile],
  };

  const metadata = {
    isRoutine: false,
    開始時刻: '09:00',
  };

  const dayState = createDayState();

  if (deletionType) {
    dayState.deletedInstances.push({
      path: taskPath,
      deletionType,
    });
  }

  const plugin = {
    settings: { slotKeys: {} as Record<string, string> },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getLogDataPath: () => 'LOGS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    },
  };

  const ctime = new Date(date).getTime();

  const context: any = {
    plugin,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'TASKS') return taskFolder;
          if (path === taskPath) return taskFile;
          return null;
        }),
        read: jest.fn(async () => '#task'),
        getMarkdownFiles: jest.fn(() => []),
        adapter: {
          stat: jest.fn(async () => ({
            ctime,
            mtime: ctime,
          })),
        },
      },
      metadataCache: {
        getFileCache: jest.fn((file: any) => {
          if (file === taskFile) {
            return { frontmatter: metadata };
          }
          return undefined;
        }),
      },
    },
    tasks: [] as any[],
    taskInstances: [] as TaskInstance[],
    renderTaskList: jest.fn(),
    currentDate: new Date(date),
    getCurrentDateString: () => date,
    ensureDayStateForCurrentDate: jest.fn(),
    getCurrentDayState: jest.fn(() => dayState),
    getDayStateSnapshot: jest.fn(() => dayState),
    getDeletedInstances: jest.fn(() => dayState.deletedInstances),
    isInstanceHidden: jest.fn(() => false),
    isInstanceDeleted: jest.fn((instanceId: string, path: string) => {
      if (path !== taskPath) return false;
      if (!deletionType) return false;
      return deletionType === 'permanent';
    }),
    generateInstanceId: jest.fn(() => `non-routine-${Math.random().toString(36).slice(2)}`),
  };

  return {
    context,
    dayState,
    taskPath,
    async load() {
      await loadTasksRefactored.call(context);
      return context;
    },
  };
}
