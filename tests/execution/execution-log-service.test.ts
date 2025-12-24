import { TFile } from 'obsidian';
import { ExecutionLogService } from '../../src/features/log/services/ExecutionLogService';
import { DEVICE_ID_STORAGE_KEY } from '../../src/services/DeviceIdentityService';
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
  const deltaStore = new Map<string, string>();

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

  const adapter = {
    append: jest.fn(async (path: string, data: string) => {
      const prev = deltaStore.get(path) ?? '';
      deltaStore.set(path, prev + data);
    }),
    read: jest.fn(async (path: string) => deltaStore.get(path) ?? ''),
    write: jest.fn(async (path: string, data: string) => {
      deltaStore.set(path, data);
    }),
    exists: jest.fn(async (path: string) => deltaStore.has(path)),
    list: jest.fn(async (path: string) => {
      const normalized = path.replace(/\/+$/, '');
      const folders = new Set<string>();
      const files: string[] = [];
      for (const key of deltaStore.keys()) {
        if (!key.startsWith(`${normalized}/`)) {
          continue;
        }
        const remainder = key.slice(normalized.length + 1);
        if (!remainder) {
          continue;
        }
        const [first, ...rest] = remainder.split('/');
        if (rest.length === 0) {
          files.push(key);
        } else {
          folders.add(`${normalized}/${first}`);
        }
      }
      return { files, folders: Array.from(folders) };
    }),
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
    adapter,
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
    routineAliasService: {
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

  return { plugin, store, pathManager, vault, deltaStore, adapter };
}

function primeDeviceId(id: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (id === null) {
    window.localStorage.removeItem(DEVICE_ID_STORAGE_KEY)
  } else {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
  }
}

beforeEach(() => {
  primeDeviceId(null)
})

function createInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  const start = overrides.startTime ?? new Date('2025-09-24T08:00:00');
  const stop = overrides.stopTime ?? new Date('2025-09-24T09:00:00');

  return {
    task: {
      title: 'Sample Task',
      name: 'Sample Task',
      path: 'Tasks/sample.md',
      isRoutine: false,
      taskId: 'tc-task-sample',
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
  test('writes delta without modifying snapshot directly', async () => {
    primeDeviceId('device-alpha');
    const { plugin, store, deltaStore, vault } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const inst = createInstance({ instanceId: 'inst-1' });
    await service.saveTaskLog(inst, 3600);

    expect(store.size).toBe(0);
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();

    const deltaPath = 'LOGS/inbox/device-alpha/2025-09.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.trim().split('\n').pop()!);
    expect(record.op).toBe('upsert');
    expect(record.payload).toEqual(
      expect.objectContaining({ instanceId: 'inst-1', taskId: 'tc-task-sample' }),
    );
  });

  test('writes delta record with device id metadata', async () => {
    primeDeviceId('device-alpha')
    const { plugin, deltaStore } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const inst = createInstance({
      instanceId: 'inst-delta',
      startTime: new Date('2025-10-01T06:00:00Z'),
      stopTime: new Date('2025-10-01T06:30:00Z'),
    });

    await service.saveTaskLog(inst, 1800);

    const deltaPath = 'LOGS/inbox/device-alpha/2025-10.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const [line] = raw!.trim().split('\n');
    const record = JSON.parse(line);
    expect(record).toEqual(
      expect.objectContaining({
        deviceId: 'device-alpha',
        monthKey: '2025-10',
        dateKey: '2025-10-01',
        op: 'upsert',
      }),
    );
    expect(record.payload).toEqual(
      expect.objectContaining({ instanceId: 'inst-delta', taskId: 'tc-task-sample' }),
    );
  });

  test('appendCommentDelta writes executionComment into delta inbox', async () => {
    primeDeviceId('device-alpha');
    const { plugin, deltaStore } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    await service.appendCommentDelta('2025-12-11', {
      instanceId: 'inst-comment',
      taskId: 'tc-task-comment',
      taskPath: 'TASKS/sample.md',
      taskTitle: 'Sample Task',
      executionComment: '集中できた',
      focusLevel: 4,
      energyLevel: 3,
      startTime: '08:00',
      stopTime: '09:00',
      durationSec: 3600,
    });

    const deltaPath = 'LOGS/inbox/device-alpha/2025-12.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.trim().split('\n').pop()!);
    expect(record.dateKey).toBe('2025-12-11');
    expect(record.payload).toEqual(
      expect.objectContaining({
        instanceId: 'inst-comment',
        executionComment: '集中できた',
        focusLevel: 4,
        energyLevel: 3,
      }),
    );
  });
});

describe('ExecutionLogService.removeTaskLogForInstanceOnDate', () => {
  test('emits delete delta and requests reconciliation without mutating snapshot directly', async () => {
    primeDeviceId('device-alpha');
    const { plugin, store, deltaStore } = createPluginStub();
    const logPath = 'LOGS/2025-09-tasks.json';
    store.set(logPath, {
      taskExecutions: {
        '2025-09-24': [
          { instanceId: 'inst-keep', taskId: 'tc-task-keep', durationSec: 600, stopTime: '09:10' },
          { instanceId: 'inst-drop', taskId: 'tc-task-drop', durationSec: 900, stopTime: '09:30' },
        ],
      },
      dailySummary: {
        '2025-09-24': {
          totalMinutes: 25,
          totalTasks: 2,
          completedTasks: 2,
          procrastinatedTasks: 0,
          completionRate: 1,
        },
      },
    });

    const service = new ExecutionLogService(plugin);
    const enqueueSpy = jest.spyOn(service as unknown as { enqueueReconcile(): void }, 'enqueueReconcile');
    enqueueSpy.mockClear();

    const snapshotBefore = JSON.parse(JSON.stringify(store.get(logPath)));

    await service.removeTaskLogForInstanceOnDate('inst-drop', '2025-09-24', 'tc-task-drop', 'TASKS/drop.md');

    expect(store.get(logPath)).toEqual(snapshotBefore);

    const deltaPath = 'LOGS/inbox/device-alpha/2025-09.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.trim().split('\n').pop()!);
    expect(record.op).toBe('delete');
    expect(record.payload).toEqual(
      expect.objectContaining({ instanceId: 'inst-drop', taskId: 'tc-task-drop', taskPath: 'TASKS/drop.md' }),
    );
    expect(enqueueSpy).toHaveBeenCalled();
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

describe('ExecutionLogService.renameTaskPath', () => {
  test('emits delta updates without modifying snapshot directly', async () => {
    primeDeviceId('device-alpha');
    const { plugin, store, deltaStore, vault } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const logPath = 'LOGS/2025-09-tasks.json';
    store.set(logPath, {
      taskExecutions: {
        '2025-09-14': [
          { taskPath: 'TASKS/old.md', taskTitle: 'Old Routine', instanceId: 'old-1' },
          { taskPath: 'TASKS/other.md', taskTitle: 'Other Task', instanceId: 'other-1' },
        ],
      },
      dailySummary: {},
    });

    await service.renameTaskPath('TASKS/old.md', 'TASKS/new.md');

    expect(vault.modify).not.toHaveBeenCalled();
    const snapshot = store.get(logPath)!;
    const entries = snapshot.taskExecutions['2025-09-14'] as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual(
      expect.objectContaining({ taskPath: 'TASKS/old.md', taskTitle: 'Old Routine' }),
    );
    expect(entries[1]).toEqual(
      expect.objectContaining({ taskPath: 'TASKS/other.md', taskTitle: 'Other Task' }),
    );

    const deltaPath = 'LOGS/inbox/device-alpha/2025-09.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const records = raw!.trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        op: 'upsert',
        dateKey: '2025-09-14',
        payload: expect.objectContaining({
          instanceId: 'old-1',
          taskPath: 'TASKS/new.md',
          taskTitle: 'Old Routine',
        }),
      }),
    );
  });

  test('emits rename delta based on pending inbox deltas when snapshot missing', async () => {
    primeDeviceId('device-alpha');
    const { plugin, deltaStore } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const pendingRecord = {
      schemaVersion: 1,
      op: 'upsert',
      entryId: 'device-beta:1',
      deviceId: 'device-beta',
      monthKey: '2025-11',
      dateKey: '2025-11-03',
      recordedAt: '2025-11-03T08:00:00.000Z',
      payload: {
        instanceId: 'inst-rename',
        taskId: 'tc-task-rename',
        taskTitle: 'Rename Me',
        taskPath: 'TASKS/old.md',
        startTime: '08:00',
        stopTime: '09:00',
      },
    };
    deltaStore.set('LOGS/inbox/device-beta/2025-11.jsonl', `${JSON.stringify(pendingRecord)}\n`);

    await service.renameTaskPath('TASKS/old.md', 'TASKS/new.md');

    const deltaPath = 'LOGS/inbox/device-alpha/2025-11.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.trim().split('\n').pop()!);
    expect(record.op).toBe('upsert');
    expect(record.dateKey).toBe('2025-11-03');
    expect(record.payload).toEqual(
      expect.objectContaining({
        instanceId: 'inst-rename',
        taskId: 'tc-task-rename',
        taskPath: 'TASKS/new.md',
      }),
    );
  });

  test('performs no writes when old path does not exist', async () => {
    const { plugin, store, vault } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    const logPath = 'LOGS/2025-10-tasks.json';
    store.set(logPath, {
      taskExecutions: {
        '2025-10-01': [{ taskPath: 'TASKS/a.md', taskTitle: 'Task A' }],
      },
      dailySummary: {},
    });

    await service.renameTaskPath('TASKS/missing.md', 'TASKS/new.md');

    expect(vault.modify).not.toHaveBeenCalled();
    const snapshot = store.get(logPath)!;
    expect(snapshot.taskExecutions['2025-10-01'][0]).toEqual({
      taskPath: 'TASKS/a.md',
      taskTitle: 'Task A',
    });
  });
});

describe('ExecutionLogService.updateDailySummaryTotals', () => {
  test('emits summary delta without mutating snapshot directly', async () => {
    primeDeviceId('device-alpha');
    const { plugin, store, deltaStore, vault } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    await service.updateDailySummaryTotals('2025-10-09', 4);

    expect(store.size).toBe(0);
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();

    const deltaPath = 'LOGS/inbox/device-alpha/2025-10.jsonl';
    const raw = deltaStore.get(deltaPath);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!.trim().split('\n').pop()!);
    expect(record.op).toBe('summary');
    expect(record.payload).toEqual({ summary: { totalTasks: 4 } });
  });

  test('skips duplicate summary deltas in the same session', async () => {
    primeDeviceId('device-alpha');
    const { plugin, deltaStore } = createPluginStub();
    const service = new ExecutionLogService(plugin);

    await service.updateDailySummaryTotals('2025-10-09', 4);
    await service.updateDailySummaryTotals('2025-10-09', 4);

    const deltaPath = 'LOGS/inbox/device-alpha/2025-10.jsonl';
    const raw = deltaStore.get(deltaPath);
    const lines = raw?.trim().split('\n') ?? [];
    expect(lines).toHaveLength(1);
  });
});
