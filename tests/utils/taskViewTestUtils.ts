import { TFile } from 'obsidian';
import { loadTasksRefactored } from '../../src/features/core/helpers';
import DayStateStoreService from '../../src/services/DayStateStoreService';
import { TaskLoaderService } from '../../src/features/core/services/TaskLoaderService';
import { isDeleted as isDeletedEntry } from '../../src/services/dayState/conflictResolver';
import {
  DayState,
  TaskInstance,
  HiddenRoutine,
  DuplicatedInstance,
  DeletedInstance,
} from '../../src/types';
import { SectionConfigService } from '../../src/services/SectionConfigService';

const DEFAULT_ROUTINE_METADATA = {
  isRoutine: true,
  routine_type: 'daily',
  routine_interval: 1,
  routine_enabled: true,
  routine_start: '2025-09-24',
  開始時刻: '08:00',
  taskId: 'tc-task-routine',
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
      getAbstractFileByPath: jest.Mock<unknown, [string]>;
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
  isInstanceDeleted: jest.Mock<boolean, [string?, string?, string?, string?]>;
  generateInstanceId: jest.Mock<string, []>;
  dayStateManager?: DayStateStoreService;
  taskLoader: TaskLoaderService;
  getSectionConfig: () => SectionConfigService;
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

function createDayStateStoreServiceStub(dayState: DayState, date: string) {
  return {
    ensure: jest.fn(async (dateKey?: string) => {
      if (dateKey && dateKey !== date) {
        return createDayState();
      }
      return dayState;
    }),
    persist: jest.fn(async () => undefined),
    getHidden: jest.fn(() => dayState.hiddenRoutines),
    getDeleted: jest.fn(() => dayState.deletedInstances),
    setDeleted: jest.fn((entries: DeletedInstance[]) => {
      const normalized = entries
        .filter(Boolean)
        .map((entry) => {
          if (!entry) return entry
          const trimmedId = typeof entry.taskId === 'string' ? entry.taskId.trim() : ''
          if (trimmedId.length > 0 && entry.taskId !== trimmedId) {
            return { ...entry, taskId: trimmedId }
          }
          return entry
        })

      const deduped: DeletedInstance[] = []
      const seen = new Set<string>()
      for (const entry of normalized) {
        if (!entry) continue
        if (entry.taskId && entry.deletionType === 'permanent') {
          if (seen.has(entry.taskId)) {
            continue
          }
          seen.add(entry.taskId)
        }
        deduped.push(entry)
      }

      dayState.deletedInstances = deduped
      return dayState.deletedInstances;
    }),
    isHidden: jest.fn(({ instanceId, path }: { instanceId?: string; path?: string }) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isDeleted: jest.fn(({ instanceId, path, taskId }: { taskId?: string; instanceId?: string; path?: string }) => {
      if (!instanceId && !path && !taskId) return false;
      return dayState.deletedInstances.some((entry) => {
        const matches =
          (entry.instanceId && entry.instanceId === instanceId) ||
          (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) ||
          (entry.deletionType === 'permanent' && entry.path === path);
        if (!matches) return false;
        return isDeletedEntry(entry);
      });
    }),
  } as unknown as DayStateStoreService;
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
  } as Record<string, unknown> & { taskId?: string };

  if (typeof metadata.taskId !== 'string' || metadata.taskId.trim().length === 0) {
    metadata.taskId = `tc-task-routine-${date}`;
  }

  const slotOverrideKey = metadata.taskId;
  const slotOverrides = slotOverride ? { [slotOverrideKey]: slotOverride } : {};
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
  const routineDayStateStoreService = createDayStateStoreServiceStub(dayState, date);
  const sectionConfig = new SectionConfigService();

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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string, taskId?: string) => {
      if (!instanceId && !path && !taskId) return false;
      return dayState.deletedInstances.some((entry) => {
        const matches =
          (entry.instanceId && entry.instanceId === instanceId) ||
          (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) ||
          (entry.deletionType === 'permanent' && entry.path === path);
        if (!matches) return false;
        return isDeletedEntry(entry);
      });
    }),
    generateInstanceId: jest.fn(() => `routine-${Math.random().toString(36).slice(2)}`),
    dayStateManager: routineDayStateStoreService,
    taskLoader: new TaskLoaderService(),
    getSectionConfig: () => sectionConfig,
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
  fileStat?: { ctime?: number; mtime?: number };
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
    fileStat,
  } = options;

  const taskPath = 'TASKS/non-routine.md';
  const taskFile = createMockTFile(taskPath, 'non-routine', 'md');
  const taskFolder = {
    children: [taskFile],
  };

  const metadata = {
    estimatedMinutes: 30,
    project: null,
    taskId: 'tc-task-non-routine',
    ...(metadataOverrides ?? {}),
  } as Record<string, unknown> & { taskId?: string };

  if (metadata.taskId === undefined || metadata.taskId === null || metadata.taskId === '') {
    delete metadata.taskId;
  }

  const timestamp = Date.now();
  const dayState = createDayState(dayStateOverrides);
  const deletionTaskId = typeof metadata.taskId === 'string' ? (metadata.taskId) : undefined;
  if (deletionType === 'permanent') {
    dayState.deletedInstances.push({
      path: taskPath,
      deletionType: 'permanent',
      timestamp,
      taskId: deletionTaskId,
    });
  } else if (deletionType === 'temporary') {
    dayState.deletedInstances.push({
      instanceId: 'temp-instance',
      path: taskPath,
      deletionType: 'temporary',
      timestamp,
      taskId: deletionTaskId,
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

  const defaultCtime = new Date(date).getTime();
  const statCtime = fileStat?.ctime ?? fileStat?.mtime ?? defaultCtime;
  const statMtime = fileStat?.mtime ?? fileStat?.ctime ?? defaultCtime;
  const nonRoutineDayStateStoreService = createDayStateStoreServiceStub(dayState, date);
  const sectionConfig = new SectionConfigService();

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
            ctime: statCtime,
            mtime: statMtime,
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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string, taskId?: string) => {
      if (!instanceId && !path && !taskId) return false;
      return dayState.deletedInstances.some((entry) => {
        const matches =
          (entry.instanceId && entry.instanceId === instanceId) ||
          (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) ||
          (entry.deletionType === 'permanent' && entry.path === path);
        if (!matches) return false;
        return isDeletedEntry(entry);
      });
    }),
    generateInstanceId: jest.fn(() => `non-routine-${Math.random().toString(36).slice(2)}`),
    dayStateManager: nonRoutineDayStateStoreService,
    taskLoader: new TaskLoaderService(),
    getSectionConfig: () => sectionConfig,
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

  const executionDayStateStoreService = createDayStateStoreServiceStub(dayState, date);
  const sectionConfig = new SectionConfigService();

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
    isInstanceHidden: jest.fn((instanceId?: string, path?: string) => {
      if (!instanceId && !path) return false;
      return dayState.hiddenRoutines.some((hidden) => {
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      });
    }),
    isInstanceDeleted: jest.fn((instanceId?: string, path?: string, _date?: string, taskId?: string) => {
      if (!instanceId && !path && !taskId) return false;
      return dayState.deletedInstances.some((entry) => {
        const matches =
          (entry.instanceId && entry.instanceId === instanceId) ||
          (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) ||
          (entry.deletionType === 'permanent' && entry.path === path);
        if (!matches) return false;
        return isDeletedEntry(entry);
      });
    }),
    generateInstanceId: jest.fn(() => `exec-${Math.random().toString(36).slice(2)}`),
    dayStateManager: executionDayStateStoreService,
    taskLoader: new TaskLoaderService(),
    getSectionConfig: () => sectionConfig,
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
