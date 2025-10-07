import { loadTasksRefactored } from '../../src/views/TaskChuteView.helpers';
import { DayState, TaskInstance } from '../../src/types';

const DEFAULT_ROUTINE_METADATA = {
  isRoutine: true,
  routine_type: 'daily',
  routine_interval: 1,
  routine_enabled: true,
  routine_start: '2025-09-24',
  開始時刻: '08:00',
};

interface TaskChuteViewContextStub {
  plugin: {
    settings: { slotKeys: Record<string, string> };
    saveSettings: jest.Mock<Promise<void>, []>;
    pathManager: {
      getTaskFolderPath: () => string;
      getProjectFolderPath: () => string;
      getLogDataPath: () => string;
      getReviewDataPath: () => string;
      ensureFolderExists: jest.Mock<Promise<void>, [string?]>;
      getLogYearPath: (year: string | number) => string;
      ensureYearFolder: jest.Mock<Promise<string>, [string | number]>;
      validatePath: (path: string) => { valid: boolean; error?: string };
    };
  };
  app: {
    vault: {
      getAbstractFileByPath: jest.Mock<unknown | null, [string]>;
      read: jest.Mock<Promise<string>, [unknown?]>;
      getMarkdownFiles: jest.Mock<unknown[], []>;
      adapter: {
        stat: jest.Mock<Promise<{ ctime: number; mtime: number }>, [string?]>;
      };
    };
    metadataCache: {
      getFileCache: jest.Mock<unknown, [unknown]>;
    };
  };
  tasks: unknown[];
  taskInstances: TaskInstance[];
  renderTaskList: jest.Mock<void, []>;
  currentDate: Date;
  getCurrentDateString: () => string;
  ensureDayStateForCurrentDate: jest.Mock<void, []>;
  getCurrentDayState: jest.Mock<DayState, []>;
  getDayStateSnapshot: jest.Mock<DayState, []>;
  getDeletedInstances: jest.Mock<DayState['deletedInstances'], []>;
  isInstanceHidden: jest.Mock<boolean, [TaskInstance?]>;
  isInstanceDeleted: jest.Mock<boolean, [TaskInstance?]>;
  generateInstanceId: jest.Mock<string, []>;
}

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

export interface RoutineContextOptions {
  date?: string;
  slotOverride?: string;
  targetDate?: string;
  metadataOverrides?: Record<string, unknown>;
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
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogYearPath: (year: string | number) => `LOGS/${year}`,
      ensureYearFolder: jest
        .fn()
        .mockImplementation(async (year: string | number) => `LOGS/${year}`),
      validatePath: () => ({ valid: true }),
    },
  };

  const ctime = new Date(date).getTime();

  const context = {
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
        getFileCache: jest.fn((file: unknown) => {
          if (file === routineFile) {
            return { frontmatter: metadata };
          }
          return undefined;
        }),
      },
    },
    tasks: [] as unknown[],
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
  } as TaskChuteViewContextStub;

  return {
    context,
    dayState,
    routinePath,
    routineMetadata: metadata,
    async load() {
      await loadTasksRefactored.call(context);
    },
  };
}

export interface NonRoutineContextOptions {
  date?: string;
  deletionType?: 'permanent' | 'temporary';
  metadataOverrides?: Record<string, unknown>;
}

export function createNonRoutineLoadContext(options: NonRoutineContextOptions = {}) {
  const { date = '2025-09-24', deletionType, metadataOverrides } = options;

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
    estimatedMinutes: 30,
    project: null,
    ...(metadataOverrides ?? {}),
  };

  const timestamp = Date.now();
  const dayState = createDayState();
  if (deletionType === 'permanent') {
    dayState.deletedInstances.push({
      path: taskPath,
      deletionType: 'permanent',
      timestamp,
    });
  } else if (deletionType === 'temporary') {
    dayState.deletedInstances.push({
      instanceId: 'temp-instance',
      path: taskPath,
      deletionType: 'temporary',
      timestamp,
    });
  }

  const plugin = {
    settings: { slotKeys: {} as Record<string, string> },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogYearPath: (year: string | number) => `LOGS/${year}`,
      ensureYearFolder: jest
        .fn()
        .mockImplementation(async (year: string | number) => `LOGS/${year}`),
      validatePath: () => ({ valid: true }),
    },
  };

  const ctime = new Date(date).getTime();

  const context = {
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
        getFileCache: jest.fn((file: unknown) => {
          if (file === taskFile) {
            return { frontmatter: metadata };
          }
          return undefined;
        }),
      },
    },
    tasks: [] as unknown[],
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
    generateInstanceId: jest.fn(() => `non-routine-${Math.random().toString(36).slice(2)}`),
  } as TaskChuteViewContextStub;

  return {
    context,
    dayState,
    nonRoutinePath: taskPath,
    async load() {
      await loadTasksRefactored.call(context);
    },
  };
}
