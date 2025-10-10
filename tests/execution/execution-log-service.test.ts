import { TFile } from 'obsidian';
import { ExecutionLogService } from '../../src/services/ExecutionLogService';
import type { TaskInstance, TaskChutePluginLike } from '../../src/types';

type StoredLogFile = {
  taskExecutions: Record<string, unknown[]>;
  dailySummary: Record<string, Record<string, number>>;
  [key: string]: unknown;
};

function createTFile(path: string) {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop() ?? path;
  Object.setPrototypeOf(file, TFile.prototype);
  return file;
}

function createPluginStub(options: { disableGetFiles?: boolean } = {}) {
  const store = new Map<string, StoredLogFile>();

  const pathManager = {
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
  };

  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => {
      if (store.has(path)) {
        return createTFile(path);
      }
      return null;
    }),
    read: jest.fn(async (file: TFile) => {
      const entry = store.get(file.path);
      return entry ? JSON.stringify(entry) : '';
    }),
    create: jest.fn(async (path: string, content: string) => {
      const parsed = JSON.parse(content) as StoredLogFile;
      store.set(path, parsed);
      return createTFile(path);
    }),
    modify: jest.fn(async (file: TFile, content: string) => {
      const parsed = JSON.parse(content) as StoredLogFile;
      store.set(file.path, parsed);
    }),
  };
  if (!options.disableGetFiles) {
    (vault as { getFiles?: () => TFile[] }).getFiles = jest.fn(() =>
      Array.from(store.keys()).map((path) => createTFile(path)),
    );
  }

  const plugin: TaskChutePluginLike = {
    app: { vault },
    settings: {
      taskFolderPath: '',
      projectFolderPath: '',
      logDataPath: 'LOGS',
      reviewDataPath: '',
      useOrderBasedSort: true,
      slotKeys: {},
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    pathManager,
    routineAliasManager: {
      loadAliases: jest.fn().mockResolvedValue({}),
    },
    dayStateService: {
      loadDay: jest.fn(),
      saveDay: jest.fn(),
      mergeDayState: jest.fn(),
      clearCache: jest.fn(),
      getDateFromKey: jest.fn((key: string) => new Date(key)),
    },
  };

  return { plugin, store, pathManager, vault };
}

function createInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  const start = overrides.startTime ?? new Date('2025-09-24T08:00:00');
  const stop = overrides.stopTime ?? new Date('2025-09-24T09:00:00');

  return {
    task: {
      title: 'Sample Task',
      name: 'Sample Task',
      path: 'Tasks/sample.md',
      isRoutine: false,
    },
    instanceId: 'inst-1',
    state: 'done',
    slotKey: '8:00-12:00',
    startTime: start,
    stopTime: stop,
    ...overrides,
  } as TaskInstance;
}

describe('ExecutionLogService.saveTaskLog', () => {
  test('counts completed instances even when metadata overlaps', async () => {
    const { plugin, store } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const inst1 = createInstance({ instanceId: 'inst-1' });
    await service.saveTaskLog(inst1, 3600);

    const logPath = 'LOGS/2025-09-tasks.json';
    let data = store.get(logPath)!;
    expect(data).toBeDefined();
    expect(data.taskExecutions['2025-09-24']).toHaveLength(1);
    expect(data.dailySummary['2025-09-24'].completedTasks).toBe(1);

    // Pre-set totalTasks to ensure it is preserved on next save
    data.dailySummary['2025-09-24'].totalTasks = 5;
    store.set(logPath, data);

    const inst2 = createInstance({
      instanceId: 'inst-2',
      startTime: new Date('2025-09-24T10:00:00'),
      stopTime: new Date('2025-09-24T10:45:00'),
    });
    await service.saveTaskLog(inst2, 2700);

    data = store.get(logPath)!;
    expect(data.taskExecutions['2025-09-24']).toHaveLength(2);
    expect(data.dailySummary['2025-09-24'].completedTasks).toBe(2);
    expect(data.dailySummary['2025-09-24'].totalTasks).toBe(5);
    expect(data.dailySummary['2025-09-24'].procrastinatedTasks).toBe(3);
  });

  test('overwrites existing entry when same instance id is logged again', async () => {
    const { plugin, store } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const base = createInstance();
    await service.saveTaskLog(base, 3600);

    const logPath = 'LOGS/2025-09-tasks.json';
    let data = store.get(logPath)!;
    expect(data.taskExecutions['2025-09-24']).toHaveLength(1);
    expect(data.taskExecutions['2025-09-24'][0]).toEqual(
      expect.objectContaining({ instanceId: 'inst-1', slotKey: '8:00-12:00' }),
    );

    const updated = createInstance({
      instanceId: 'inst-1',
      slotKey: '12:00-16:00',
      startTime: new Date('2025-09-24T12:00:00'),
      stopTime: new Date('2025-09-24T13:00:00'),
    });
    await service.saveTaskLog(updated, 3600);

    data = store.get(logPath)!;
    expect(data.taskExecutions['2025-09-24']).toHaveLength(1);
    expect(data.taskExecutions['2025-09-24'][0]).toEqual(
      expect.objectContaining({ instanceId: 'inst-1', slotKey: '12:00-16:00' }),
    );
    expect(data.dailySummary['2025-09-24'].completedTasks).toBe(1);
  });
});

describe('ExecutionLogService.hasExecutionHistory', () => {
  test('returns true when any log entry matches path using getFiles', async () => {
    const { plugin, store, vault } = createPluginStub();
    store.set('LOGS/2025-10-tasks.json', {
      taskExecutions: {
        '2025-10-09': [
          { taskPath: 'Tasks/sample.md' },
          { taskPath: 'Tasks/other.md' },
        ],
      },
      dailySummary: {},
    });
    const service = new ExecutionLogService(plugin);

    const result = await service.hasExecutionHistory('Tasks/sample.md');

    expect(result).toBe(true);
    expect(vault.getFiles).toHaveBeenCalled();
    expect(vault.read).toHaveBeenCalled();
  });

  test('falls back to month probing when getFiles unavailable', async () => {
    const { plugin, store, vault } = createPluginStub({ disableGetFiles: true });
    store.set('LOGS/2025-08-tasks.json', {
      taskExecutions: {
        '2025-08-12': [{ taskPath: 'Tasks/history.md' }],
      },
      dailySummary: {},
    });
    const service = new ExecutionLogService(plugin);

    const result = await service.hasExecutionHistory('Tasks/history.md');

    expect(result).toBe(true);
    expect(vault.getAbstractFileByPath).toHaveBeenCalledWith('LOGS/2025-08-tasks.json');
  });

  test('returns false when no log entries exist for path', async () => {
    const { plugin, store } = createPluginStub();
    store.set('LOGS/2025-10-tasks.json', {
      taskExecutions: {
        '2025-10-09': [{ taskPath: 'Tasks/another.md' }],
      },
      dailySummary: {},
    });
    const service = new ExecutionLogService(plugin);

    const result = await service.hasExecutionHistory('Tasks/missing.md');

    expect(result).toBe(false);
  });
});

describe('ExecutionLogService.updateDailySummaryTotals', () => {
  test('creates snapshot when log file is missing', async () => {
    const { plugin, store } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    await service.updateDailySummaryTotals('2025-10-09', 4);

    const data = store.get('LOGS/2025-10-tasks.json');
    expect(data).toBeDefined();
    expect(data?.dailySummary['2025-10-09']).toEqual(
      expect.objectContaining({
        totalTasks: 4,
        completedTasks: 0,
        procrastinatedTasks: 4,
        completionRate: 0,
      }),
    );
    expect(data?.taskExecutions['2025-10-09']).toEqual([]);
  });

  test('recomputes summary metrics from existing executions', async () => {
    const { plugin, store } = createPluginStub();
    store.set('LOGS/2025-09-tasks.json', {
      taskExecutions: {
        '2025-09-24': [
      {
        instanceId: 'inst-1',
        durationSec: 1800,
        stopTime: '09:30',
        isCompleted: true,
      },
      {
        instanceId: 'inst-2',
        durationSec: 600,
        stopTime: '',
        isCompleted: false,
      },
        ],
      },
      dailySummary: {
        '2025-09-24': {
          totalMinutes: 999,
          totalTasks: 2,
          completedTasks: 1,
          procrastinatedTasks: 1,
          completionRate: 0.5,
        },
      },
    });
    const service = new ExecutionLogService(plugin);

    await service.updateDailySummaryTotals('2025-09-24', 6);

    const data = store.get('LOGS/2025-09-tasks.json');
    expect(data).toBeDefined();
    const summary = data?.dailySummary['2025-09-24'];
    expect(summary).toEqual(
      expect.objectContaining({
        totalTasks: 6,
        completedTasks: 1,
        procrastinatedTasks: 5,
        completionRate: 1 / 6,
        totalMinutes: 40,
      }),
    );
  });
});
