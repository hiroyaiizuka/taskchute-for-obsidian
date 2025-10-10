import { TFile } from 'obsidian';
import { loadTasksRefactored } from '../../src/views/taskchute/helpers';
import DayStateManager from '../../src/services/DayStateManager';
import { TaskLoaderService } from '../../src/services/TaskLoaderService';
import {
  DayState,
  TaskInstance,
  HiddenRoutine,
  DuplicatedInstance,
  DeletedInstance,
} from '../../src/types';

const DEFAULT_ROUTINE_METADATA = {
  isRoutine: true,
  routine_type: 'daily',
  routine_interval: 1,
  routine_enabled: true,
  routine_start: '2025-09-24',
  開始時刻: '08:00',
};

function createMockTFile(path: string, basename: string, extension: string): TFile {
  const file = new TFile();
  const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {};
  if (Object.getPrototypeOf(file) !== proto) {
    Object.setPrototypeOf(file, proto);
  }
  if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
    (file as { constructor?: unknown }).constructor = TFile;
  }
  file.path = path;
  file.basename = basename;
  file.extension = extension;
  return file;
}

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
  isInstanceHidden: jest.Mock<boolean, [string?, string?, string?]>;
  isInstanceDeleted: jest.Mock<boolean, [string?, string?, string?]>;
  generateInstanceId: jest.Mock<string, []>;
  dayStateManager?: DayStateManager;
  taskLoader: TaskLoaderService;
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

function createDayStateManagerStub(dayState: DayState, date: string) {
  return {
    ensure: jest.fn(async (dateKey?: string) => {
      if (dateKey && dateKey !== date) {
        return createDayState();
      }
      return dayState;
    }),
    getHidden: jest.fn(() => dayState.hiddenRoutines),
    getDeleted: jest.fn(() => dayState.deletedInstances),
    isHidden: jest.fn(({ instanceId, path }: { instanceId?: string; path?: string }) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isDeleted: jest.fn(({ instanceId, path }: { instanceId?: string; path?: string }) => {
      if (!instanceId && !path) return false;
      return dayState.deletedInstances.some((entry) => {
        if (entry.instanceId && entry.instanceId === instanceId) return true;
        if (entry.deletionType === 'permanent' && entry.path === path) return true;
        return false;
      });
    }),
  } as unknown as DayStateManager;
}

export interface RoutineContextOptions {
  date?: string;
  slotOverride?: string;
  targetDate?: string;
  metadataOverrides?: Record<string, unknown>;
  hiddenRoutines?: HiddenRoutine[];
  duplicatedInstances?: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>;
  deletedInstances?: DeletedInstance[];
  dayStateOverrides?: Partial<DayState>;
}

export function createRoutineLoadContext(options: RoutineContextOptions = {}) {
  const {
    date = '2025-09-24',
    slotOverride,
    targetDate,
    metadataOverrides,
    hiddenRoutines,
    duplicatedInstances,
    deletedInstances,
    dayStateOverrides,
  } = options;

  const routinePath = 'TASKS/routine.md';
  const routineFile = createMockTFile(routinePath, 'routine', 'md');
  const taskFolder = {
    children: [routineFile],
  };

  const metadata = {
    ...DEFAULT_ROUTINE_METADATA,
    ...(targetDate ? { target_date: targetDate } : {}),
    ...(metadataOverrides ?? {}),
  };

  const slotOverrides = slotOverride ? { [routinePath]: slotOverride } : {};
  const dayState = createDayState({
    slotOverrides,
    ...(dayStateOverrides ?? {}),
  });
  if (hiddenRoutines) {
    dayState.hiddenRoutines = [...hiddenRoutines];
  }
  if (duplicatedInstances) {
    dayState.duplicatedInstances = [...duplicatedInstances];
  }

  if (deletedInstances) {
    dayState.deletedInstances = [...deletedInstances];
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
  const routineDayStateManager = createDayStateManagerStub(dayState, date);

  const context = {
    plugin,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'TASKS') return taskFolder;
          if (path === routinePath) return routineFile;
          return null;
        }),
        read: jest.fn(async (file?: unknown) => {
          if (file === routineFile) {
            return '#task';
          }
          return '#task';
        }),
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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.deletedInstances.some((entry) => {
        if (entry.instanceId && entry.instanceId === instanceId) return true;
        if (entry.deletionType === 'permanent' && entry.path === path) return true;
        return false;
      });
    }),
    generateInstanceId: jest.fn(() => `routine-${Math.random().toString(36).slice(2)}`),
    dayStateManager: routineDayStateManager,
    taskLoader: new TaskLoaderService(),
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
  hiddenRoutines?: HiddenRoutine[];
  duplicatedInstances?: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>;
  deletedInstances?: DeletedInstance[];
  dayStateOverrides?: Partial<DayState>;
}

export function createNonRoutineLoadContext(options: NonRoutineContextOptions = {}) {
  const {
    date = '2025-09-24',
    deletionType,
    metadataOverrides,
    hiddenRoutines,
    duplicatedInstances,
    deletedInstances,
    dayStateOverrides,
  } = options;

  const taskPath = 'TASKS/non-routine.md';
  const taskFile = createMockTFile(taskPath, 'non-routine', 'md');
  const taskFolder = {
    children: [taskFile],
  };

  const metadata = {
    estimatedMinutes: 30,
    project: null,
    ...(metadataOverrides ?? {}),
  };

  const timestamp = Date.now();
  const dayState = createDayState(dayStateOverrides);
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
  if (hiddenRoutines) {
    dayState.hiddenRoutines = [...hiddenRoutines];
  }
  if (duplicatedInstances) {
    dayState.duplicatedInstances = [...duplicatedInstances];
  }
  if (deletedInstances) {
    dayState.deletedInstances = [...deletedInstances];
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
  const nonRoutineDayStateManager = createDayStateManagerStub(dayState, date);

  const context = {
    plugin,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'TASKS') return taskFolder;
          if (path === taskPath) return taskFile;
          return null;
        }),
        read: jest.fn(async (file?: unknown) => {
          if (file === taskFile) {
            return '#task';
          }
          return '#task';
        }),
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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.deletedInstances.some((entry) => {
        if (entry.instanceId && entry.instanceId === instanceId) return true;
        if (entry.deletionType === 'permanent' && entry.path === path) return true;
        return false;
      });
    }),
    generateInstanceId: jest.fn(() => `non-routine-${Math.random().toString(36).slice(2)}`),
    dayStateManager: nonRoutineDayStateManager,
    taskLoader: new TaskLoaderService(),
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

export interface ExecutionLogContextOptions {
  date?: string;
  executions?: Array<{
    taskTitle?: string;
    taskPath?: string;
    slotKey?: string;
    instanceId?: string;
    startTime?: string;
    stopTime?: string;
  }>;
  hiddenRoutines?: HiddenRoutine[];
  deletedInstances?: DeletedInstance[];
  duplicatedInstances?: Array<DuplicatedInstance & { slotKey?: string; originalSlotKey?: string }>;
  taskFiles?: Array<{
    path: string;
    frontmatter?: Record<string, unknown>;
    content?: string;
  }>;
}

export function createExecutionLogContext(options: ExecutionLogContextOptions = {}) {
  const {
    date = '2025-09-24',
    executions = [
      {
        taskTitle: 'Log Task',
        taskPath: 'TASKS/log-task.md',
        slotKey: '08:00-09:00',
        instanceId: 'log-instance-1',
        startTime: `${date}T00:00:00.000Z`,
      },
    ],
    hiddenRoutines,
    deletedInstances,
    duplicatedInstances,
    taskFiles = [],
  } = options;

  const [year, month] = date.split('-');
  const logPath = `LOGS/${year}-${month}-tasks.json`;
  const logFile = createMockTFile(logPath, `${year}-${month}-tasks`, 'json');

  const dayState = createDayState();
  if (hiddenRoutines) {
    dayState.hiddenRoutines = [...hiddenRoutines];
  }
  if (deletedInstances) {
    dayState.deletedInstances = [...deletedInstances];
  }
  if (duplicatedInstances) {
    dayState.duplicatedInstances = [...duplicatedInstances];
  }

  const executionDayStateManager = createDayStateManagerStub(dayState, date);

  const taskFileEntries = taskFiles.map((descriptor) => {
    const file = createMockTFile(descriptor.path, descriptor.path.split('/').pop() ?? descriptor.path, 'md');
    return {
      file,
      content: descriptor.content ?? '#task',
      frontmatter: descriptor.frontmatter,
    };
  });

  const logContent = JSON.stringify(
    {
      taskExecutions: {
        [date]: executions,
      },
    },
    null,
    2,
  );

  const taskFolder = {
    children: taskFileEntries.map((entry) => entry.file),
  };

  const plugin = {
    settings: { slotKeys: {} as Record<string, string> },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogYearPath: (yearArg: string | number) => `LOGS/${yearArg}`,
      ensureYearFolder: jest.fn().mockResolvedValue(`LOGS/${year}`),
      validatePath: () => ({ valid: true }),
    },
  };

  const context = {
    plugin,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === plugin.pathManager.getTaskFolderPath()) {
            return taskFolder;
          }
          if (path === logPath) {
            return logFile;
          }
          const match = taskFileEntries.find((entry) => entry.file.path === path);
          if (match) {
            return match.file;
          }
          return null;
        }),
        read: jest.fn(async (file: unknown) => {
          if (file === logFile) {
            return logContent;
          }
          const match = taskFileEntries.find((entry) => entry.file === file);
          if (match) {
            return match.content;
          }
          return '#task';
        }),
        getMarkdownFiles: jest.fn(() => taskFileEntries.map((entry) => entry.file)),
        adapter: {
          stat: jest.fn(async () => ({
            ctime: new Date(date).getTime(),
            mtime: new Date(date).getTime(),
          })),
        },
      },
      metadataCache: {
        getFileCache: jest.fn((file: unknown) => {
          const match = taskFileEntries.find((entry) => entry.file === file);
          if (match && match.frontmatter) {
            return { frontmatter: match.frontmatter };
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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string) => {
      if (!instanceId && !path) return false;
      return dayState.deletedInstances.some((entry) => {
        if (entry.instanceId && entry.instanceId === instanceId) return true;
        if (entry.deletionType === 'permanent' && entry.path === path) return true;
        return false;
      });
    }),
    generateInstanceId: jest.fn(() => `exec-${Math.random().toString(36).slice(2)}`),
    dayStateManager: executionDayStateManager,
    taskLoader: new TaskLoaderService(),
  } as TaskChuteViewContextStub;

  return {
    context,
    dayState,
    logPath,
    async load() {
      await loadTasksRefactored.call(context);
    },
  };
}
