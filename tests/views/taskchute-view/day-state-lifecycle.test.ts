import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView';
import {
  AutocompleteInstance,
  DayState,
  HiddenRoutine,
  TaskChutePluginLike,
  TaskData,
  TaskInstance,
} from '../../../src/types';
import { WorkspaceLeaf, TFile } from 'obsidian';
import DayStateStoreService from '../../../src/services/DayStateStoreService';
import RoutineManagerModal from '../../../src/features/routine/modals/RoutineManagerModal';
import { ReviewService } from '../../../src/features/review/services/ReviewService';
import { LogView } from '../../../src/features/log/views/LogView';
import {
  createExecutionLogContext,
  createNonRoutineLoadContext,
  createRoutineLoadContext,
} from '../../utils/taskViewTestUtils';
import { HeatmapService } from '../../../src/features/log/services/HeatmapService';
jest.mock('obsidian');
jest.mock('../../../src/features/log/services/HeatmapService', () => {
  const updateDailyStats = jest.fn().mockResolvedValue(undefined);
  return {
    HeatmapService: jest.fn().mockImplementation(() => ({
      updateDailyStats,
    })),
  };
});
jest.mock('../../../src/features/routine/modals/RoutineManagerModal');
jest.mock('../../../src/features/review/services/ReviewService', () => {
  const ensureReviewFile = jest.fn().mockResolvedValue({ path: 'REVIEWS/2025-10-09.md' })
  const openInSplit = jest.fn().mockResolvedValue(undefined)
  return {
    ReviewService: jest.fn().mockImplementation(() => ({
      ensureReviewFile,
      openInSplit,
    })),
  }
})
jest.mock('../../../src/features/log/views/LogView', () => {
  return {
    LogView: jest.fn().mockImplementation(() => ({
      render: jest.fn(),
    })),
  }
})

const mockedHeatmapService = HeatmapService as jest.MockedClass<typeof HeatmapService>;
const MockedRoutineManagerModal = RoutineManagerModal as unknown as jest.MockedClass<typeof RoutineManagerModal>;
const MockedReviewService = ReviewService as jest.MockedClass<typeof ReviewService>;
const MockedLogView = LogView as jest.MockedClass<typeof LogView>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type MoveCalendarStub = {
  close: jest.Mock<void, []>;
};

type TimerServiceStub = {
  dispose: jest.Mock<void, []>;
};

function createDayState(overrides: Partial<DayState> = {}): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
    ...overrides,
  } as DayState;
}

function createPluginStub() {
  const dayStateService = {
    loadDay: jest.fn(async () => createDayState()),
    saveDay: jest.fn(async () => undefined),
    consumeLocalStateWrite: jest.fn(() => false),
  };

  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        getFiles: jest.fn(() => []),
        read: jest.fn(async () => ''),
        modify: jest.fn(),
        create: jest.fn(),
        on: jest.fn(() => ({ detach: jest.fn() })),
        adapter: {
          stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
          exists: jest.fn(async () => false),
          read: jest.fn(async () => '{}'),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
      setting: {
        open: jest.fn(),
        openTabById: jest.fn(),
      },
      commands: {
        commands: { 'terminal:open-terminal.integrated.root': {} },
        executeCommandById: jest.fn(),
      },
    },
    settings: {
      slotKeys: {},
      useOrderBasedSort: true,
      taskFolderPath: 'TASKS',
      projectFolderPath: 'PROJECTS',
      logDataPath: 'LOGS',
      reviewDataPath: 'REVIEWS',
      aiRobotButtonEnabled: false,
    },
    saveSettings: jest.fn(),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn(),
      getLogYearPath: (year: string | number) => `${year}`,
      ensureYearFolder: jest.fn(async (year: string | number) => `${year}`),
      validatePath: () => ({ valid: true }),
    },
    dayStateService,
    routineAliasService: {
      getRouteNameFromAlias: jest.fn((name: string) => name),
      loadAliases: jest.fn().mockResolvedValue({}),
    },
    manifest: {
      id: 'taskchute-plus',
    },
    _notify: jest.fn(),
  } as unknown as TaskChutePluginLike & {
    dayStateService: typeof dayStateService;
  };

  return { plugin, dayStateService };
}

function createView() {
  const { plugin, dayStateService } = createPluginStub();
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf;

  const view = new TaskChuteView(leaf, plugin);
  view.containerEl = document.createElement('div');
  view.app = plugin.app;
  (view as Mutable<TaskChuteView>)['currentDate'] = new Date(2025, 0, 1);
  (view as Mutable<TaskChuteView>)['registerEvent'] = jest.fn();
  (view as Mutable<TaskChuteView>)['registerDomEvent'] = jest.fn();

  return { view, plugin, dayStateService };
}

function createTaskData(overrides: Partial<TaskData> = {}): TaskData {
  const defaultPath = typeof overrides.path === 'string' ? overrides.path : 'TASKS/base.md'
  const defaultTaskId = typeof overrides.taskId === 'string' ? overrides.taskId : `tc-task-${defaultPath.replace(/[^a-z0-9]/gi, '-')}`
  return {
    file: null,
    frontmatter: {},
    path: defaultPath,
    name: 'Base Task',
    displayTitle: 'Base Task',
    isRoutine: false,
    taskId: defaultTaskId,
    ...overrides,
  } as TaskData;
}

function createTaskInstance(task: TaskData, overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    task,
    instanceId: 'instance-1',
    state: 'idle',
    slotKey: '8:00-12:00',
    ...overrides,
  } as TaskInstance;
}

type CreateElCapableElement = HTMLElement & {
  createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement;
  createSpan?: (options?: Record<string, unknown>) => HTMLElement;
};

function attachRecursiveCreateEl(target: HTMLElement): void {
  const typed = target as CreateElCapableElement;
  typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
    const el = document.createElement(tag);
    if (options.cls) {
      el.className = options.cls as string;
    }
    if (options.text) {
      el.textContent = options.text as string;
    }
    if (options.attr) {
      Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    attachRecursiveCreateEl(el);
    this.appendChild(el);
    return el;
  };
  typed.createSpan = function (options: Record<string, unknown> = {}) {
    return this.createEl?.('span', options) ?? document.createElement('span');
  };
  (typed as HTMLElement & {
    createSvg?: (tag: string, options?: { attr?: Record<string, string>; cls?: string }) => SVGElement;
  }).createSvg = function (this: HTMLElement, tag: string, options: { attr?: Record<string, string>; cls?: string } = {}) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (options.cls) {
      svg.setAttribute('class', options.cls);
    }
    if (options.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        svg.setAttribute(key, value);
      });
    }
    attachRecursiveCreateEl(svg as unknown as HTMLElement);
    this.appendChild(svg as unknown as HTMLElement);
    return svg as unknown as SVGElement;
  };
  if (typeof (typed as { empty?: () => void }).empty !== 'function') {
    (typed as { empty: () => void }).empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }
}

describe('TaskChuteView day-state lifecycle', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('ensureDayStateForCurrentDate caches state and avoids duplicate loads', async () => {
    const { view, dayStateService } = createView();

    const first = await view.ensureDayStateForCurrentDate();
    expect(dayStateService.loadDay).toHaveBeenCalledTimes(1);

    const second = await view.ensureDayStateForCurrentDate();
    expect(dayStateService.loadDay).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(view['currentDayState']).toBe(first);
    expect(view['currentDayStateKey']).toBe('2025-01-01');
  });

  test('ensureDayStateForCurrentDate reloads when date changes', async () => {
    const { view, dayStateService } = createView();

    dayStateService.loadDay.mockImplementationOnce(async () => createDayState({ hiddenRoutines: ['day-1'] }));
    const first = await view.ensureDayStateForCurrentDate();
    expect(first.hiddenRoutines).toContain('day-1');

    dayStateService.loadDay.mockImplementationOnce(async () => createDayState({ hiddenRoutines: ['day-2'] }));
    (view as Mutable<TaskChuteView>)['currentDate'] = new Date(2025, 0, 2);

    const second = await view.ensureDayStateForCurrentDate();
    expect(dayStateService.loadDay).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.hiddenRoutines).toContain('day-2');
    expect(view['currentDayStateKey']).toBe('2025-01-02');
  });

  test('persistDayState saves cached day state using parsed date', async () => {
    const { view, dayStateService } = createView();

    const state = await view.ensureDayStateForCurrentDate();
    state.hiddenRoutines.push('cached');

    await (view as unknown as { persistDayState: (dateStr: string) => Promise<void> }).persistDayState('2025-01-01');

    expect(dayStateService.saveDay).toHaveBeenCalledTimes(1);
    const [savedDate, savedState] = dayStateService.saveDay.mock.calls[0];
    expect(savedDate).toBeInstanceOf(Date);
    expect(savedDate.getFullYear()).toBe(2025);
    expect(savedDate.getMonth()).toBe(0);
    expect(savedDate.getDate()).toBe(1);
    expect(savedState).toBe(state);
  });

  test('persistDayState ignores missing cache entries', async () => {
    const { view, dayStateService } = createView();

    await (view as unknown as { persistDayState: (dateStr: string) => Promise<void> }).persistDayState('2025-01-03');

    expect(dayStateService.saveDay).not.toHaveBeenCalled();
  });

  test('getCurrentDayState lazily initialises cache without hitting loader', () => {
    const { view, dayStateService } = createView();

    const state = view.getCurrentDayState();
    expect(state.hiddenRoutines).toEqual([]);
    expect(state.deletedInstances).toEqual([]);
    expect(view['dayStateCache'].get('2025-01-01')).toBe(state);
    expect(view['currentDayState']).toBe(state);
    expect(view['currentDayStateKey']).toBe('2025-01-01');
    expect(dayStateService.loadDay).not.toHaveBeenCalled();
  });


});

describe('TaskChuteView execution history helpers', () => {
  test('hasExecutionHistory delegates to executionLogService', async () => {
    const { view } = createView();
    const spy = jest
      .spyOn(view.executionLogService, 'hasExecutionHistory')
      .mockResolvedValue(true);

    const result = await (view as unknown as {
      hasExecutionHistory: (taskPath: string) => Promise<boolean>;
    }).hasExecutionHistory('Tasks/sample.md');

    expect(spy).toHaveBeenCalledWith('Tasks/sample.md');
    expect(result).toBe(true);
  });

  test('hasExecutionHistory returns false when service throws', async () => {
    const { view } = createView();
    jest
      .spyOn(view.executionLogService, 'hasExecutionHistory')
      .mockRejectedValue(new Error('failure'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await (view as unknown as {
      hasExecutionHistory: (taskPath: string) => Promise<boolean>;
    }).hasExecutionHistory('Tasks/sample.md');

    expect(result).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('TaskChuteView handleFileRename', () => {
  test('keeps instanceId stable when task path changes', async () => {
    const { view } = createView();
    const oldPath = 'TASKS/old.md';
    const newPath = 'TASKS/new.md';
    const task = createTaskData({ path: oldPath, name: 'Old Task' });
    const instanceId = `${oldPath}_2025-01-01_123_abc`;
    const instance = createTaskInstance(task, { instanceId });

    view.tasks = [task];
    view.taskInstances = [instance];
    view.currentInstance = instance;

    const file = new TFile();
    file.path = newPath;
    (file as { basename?: string }).basename = 'new';
    (file as { extension?: string }).extension = 'md';
    (file as { name?: string }).name = 'new.md';
    Object.setPrototypeOf(file, TFile.prototype);

    (view.app.metadataCache.getFileCache as jest.Mock).mockReturnValue({
      frontmatter: { title: 'New Title' },
    });

    jest
      .spyOn(view.executionLogService, 'renameTaskPath')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view.dayStateManager, 'renameTaskPath')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view.runningTasksService, 'renameTaskPath')
      .mockResolvedValue(undefined);
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);

    await (view as unknown as { handleFileRename: (file: TFile, oldPath: string) => Promise<void> }).handleFileRename(
      file,
      oldPath,
    );

    expect(instance.task.path).toBe(newPath);
    expect(instance.instanceId).toBe(instanceId);
    expect(view.currentInstance?.instanceId).toBe(instanceId);
    expect(reloadSpy).toHaveBeenCalled();
  });
});


describe('TaskChuteView reloadTasksAndRestore', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('reloadTasksAndRestore delegates to coordinator', async () => {
    const { view } = createView();
    const reloadSpy = jest
      .spyOn(view.taskReloadCoordinator, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);

    await (view as unknown as { reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void> }).reloadTasksAndRestore({ runBoundaryCheck: true });

    expect(reloadSpy).toHaveBeenCalledWith({ runBoundaryCheck: true });
  });

});

describe('TaskChuteView loadTasks cache clearing', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('loadTasks clears only current date cache by default', async () => {
    const { view } = createView();
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');
    jest
      .spyOn(view.executionLogService, 'ensureReconciled')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view as unknown as { ensureDayStateForCurrentDate: () => Promise<DayState> }, 'ensureDayStateForCurrentDate')
      .mockResolvedValue(createDayState());
    jest
      .spyOn(view.taskLoader, 'load')
      .mockResolvedValue(undefined);

    await (view as unknown as { loadTasks: (options?: { clearDayStateCache?: string }) => Promise<void> }).loadTasks();

    expect(clearSpy).toHaveBeenCalledWith('2025-01-01');
    const calledWithoutArgs = clearSpy.mock.calls.some((call) => call.length === 0);
    expect(calledWithoutArgs).toBe(false);
  });

  test('loadTasks clears all caches when requested', async () => {
    const { view } = createView();
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');
    jest
      .spyOn(view.executionLogService, 'ensureReconciled')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view as unknown as { ensureDayStateForCurrentDate: () => Promise<DayState> }, 'ensureDayStateForCurrentDate')
      .mockResolvedValue(createDayState());
    jest
      .spyOn(view.taskLoader, 'load')
      .mockResolvedValue(undefined);

    await (view as unknown as { loadTasks: (options?: { clearDayStateCache?: string }) => Promise<void> }).loadTasks({
      clearDayStateCache: 'all',
    });

    expect(clearSpy).toHaveBeenCalledTimes(1);
    const call = clearSpy.mock.calls[0] ?? [];
    expect(call.length).toBe(0);
  });

  test('loadTasks continues when endWriteBarrier fails', async () => {
    const { view } = createView();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    jest
      .spyOn(view.executionLogService, 'ensureReconciled')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view as unknown as { ensureDayStateForCurrentDate: () => Promise<DayState> }, 'ensureDayStateForCurrentDate')
      .mockResolvedValue(createDayState());
    jest
      .spyOn(view.taskLoader, 'load')
      .mockResolvedValue(undefined);

    jest
      .spyOn(view.dayStateManager, 'endWriteBarrier')
      .mockRejectedValueOnce(new Error('flush failed'));

    const processBarrierSpy = jest
      .spyOn(view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }, 'processBarrierPendingExternalChanges')
      .mockResolvedValue(undefined);
    const reminderSpy = jest
      .spyOn(view as unknown as { buildReminderSchedules: () => void }, 'buildReminderSchedules')
      .mockImplementation(() => undefined);

    await expect(
      (view as unknown as { loadTasks: (options?: { clearDayStateCache?: string }) => Promise<void> }).loadTasks(),
    ).resolves.toBeUndefined();

    expect(processBarrierSpy).toHaveBeenCalledTimes(1);
    expect(reminderSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[TaskChuteView] endWriteBarrier failed during loadTasks:',
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});

describe('TaskChuteView onOpen cache clearing', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('onOpen reloads with full cache clear', async () => {
    const { view } = createView();
    view.containerEl = document.createElement('div');
    view.containerEl.appendChild(document.createElement('div'));
    const content = document.createElement('div');
    (content as unknown as { empty?: () => void }).empty = jest.fn();
    view.containerEl.appendChild(content);

    jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    (view as Mutable<TaskChuteView>).setupUI = jest.fn();
    (view as Mutable<TaskChuteView>).ensureTimerService = jest.fn();
    (view as Mutable<TaskChuteView>).setupResizeObserver = jest.fn();
    view.navigationController.initializeNavigationEventListeners = jest.fn();
    (view as Mutable<TaskChuteView>).setupEventListeners = jest.fn();

    await view.onOpen();

    expect(view.reloadTasksAndRestore).toHaveBeenCalledWith({
      runBoundaryCheck: true,
      clearDayStateCache: 'all',
    });
  });
});


describe('TaskChuteView duplication and deletion', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('duplicateInstance creates cloned instance and records metadata', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    view.renderTaskList = jest.fn();

    const persistSpy = jest
      .spyOn(view as unknown as Record<string, unknown>, 'persistDayState')
      .mockResolvedValue(undefined);
    const idSpy = jest
      .spyOn(view as unknown as Record<string, unknown>, 'generateInstanceId')
      .mockReturnValue('dup-123');

    const task = createTaskData();
    const original = createTaskInstance(task, { instanceId: 'orig-1' });
    view.taskInstances = [original];

    const dayState = view.getCurrentDayState();
    expect(dayState.duplicatedInstances).toHaveLength(0);

    const duplicated = (await (view as unknown as {
      duplicateInstance: (
        inst: TaskInstance,
        returnOnly?: boolean,
      ) => Promise<TaskInstance | void>;
    }).duplicateInstance(original, true)) as TaskInstance | undefined;

    expect(duplicated).toBeDefined();
    expect(duplicated?.instanceId).toBe('dup-123');
    expect(duplicated?.createdMillis).toEqual(expect.any(Number));
    expect(view.taskInstances).toContain(duplicated);
    expect(dayState.duplicatedInstances).toHaveLength(1);
    expect(dayState.duplicatedInstances[0]).toMatchObject({
      instanceId: 'dup-123',
      originalPath: task.path,
      slotKey: original.slotKey,
    });
    expect(dayState.duplicatedInstances[0]?.createdMillis).toBe(duplicated?.createdMillis);
    expect(persistSpy).toHaveBeenCalledWith('2025-01-01');
    expect(view.renderTaskList).toHaveBeenCalled();

    idSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test('removeDuplicateInstanceFromCurrentDate records temporary deletion entry', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/dup.md' });
    const instance = createTaskInstance(task, { instanceId: 'dup-1' });

    const dayState = view.getCurrentDayState();
    dayState.duplicatedInstances.push({
      instanceId: 'dup-1',
      originalPath: 'TASKS/dup.md',
      slotKey: 'none',
      timestamp: 1000,
      createdMillis: 1000,
    });

    await (view as unknown as {
      removeDuplicateInstanceFromCurrentDate: (inst: TaskInstance) => Promise<void>
    }).removeDuplicateInstanceFromCurrentDate(instance);

    expect(dayState.duplicatedInstances.some((entry) => entry.instanceId === 'dup-1')).toBe(false);
    const deletion = dayState.deletedInstances.find((entry) => entry.instanceId === 'dup-1');
    expect(deletion).toBeDefined();
    expect(deletion?.deletionType).toBe('temporary');
    expect(deletion?.deletedAt).toEqual(expect.any(Number));
  });

  test('deleteInstance marks non-routine task as permanent deletion when last instance', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    view.renderTaskList = jest.fn();
    jest
      .spyOn(view.taskMutationService, 'deleteTaskLogsByInstanceId')
      .mockResolvedValue(0);

    const trashFile = jest.fn().mockResolvedValue(undefined);
    view.app = {
      ...view.app,
      fileManager: {
        trashFile,
      },
    } as typeof view.app;

    const file = new TFile();
    file.path = 'TASKS/base.md';
    const task = createTaskData({ file });
    const original = createTaskInstance(task, { instanceId: 'orig-1' });
    view.taskInstances = [original];
    view.tasks = [task];

    await (view as unknown as { deleteInstance: (inst: TaskInstance) => Promise<void> }).deleteInstance(original);

    expect(view.taskInstances).toHaveLength(0);
    const deleted = view.dayStateManager.getDeleted('2025-01-01');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      path: task.path,
      deletionType: 'permanent',
    });
    expect(view.tasks).toHaveLength(0);
  });

  test('deleteInstance removes duplicate metadata and records temporary deletion', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    view.renderTaskList = jest.fn();
    jest
      .spyOn(view.taskMutationService, 'deleteTaskLogsByInstanceId')
      .mockResolvedValue(0);

    const trashFile = jest.fn().mockResolvedValue(undefined);
    view.app = {
      ...view.app,
      fileManager: {
        trashFile,
      },
    } as typeof view.app;

    const file = new TFile();
    file.path = 'TASKS/base.md';
    const task = createTaskData({ file });
    const baseInstance = createTaskInstance(task, { instanceId: 'orig-1' });
    const duplicate = createTaskInstance(task, { instanceId: 'dup-1' });
    const dayState = view.getCurrentDayState();
    dayState.duplicatedInstances.push({
      instanceId: 'dup-1',
      originalPath: task.path,
      slotKey: duplicate.slotKey,
      timestamp: 10,
    });

    view.taskInstances = [baseInstance, duplicate];
    view.tasks = [task];

    await (view as unknown as { deleteInstance: (inst: TaskInstance) => Promise<void> }).deleteInstance(duplicate);

    const deleted = view.dayStateManager.getDeleted('2025-01-01');
    expect(deleted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: 'dup-1',
          deletionType: 'temporary',
        }),
      ])
    );
    expect(dayState.duplicatedInstances.find((d) => d.instanceId === 'dup-1')).toBeUndefined();
    expect(trashFile).not.toHaveBeenCalled();
    expect(view.taskInstances).toHaveLength(1);
    expect(view.taskInstances[0].instanceId).toBe('orig-1');
  });

  test('duplicate creation then delete duplicate keeps base task visible after reload', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    view.renderTaskList = jest.fn();

    const file = new TFile();
    file.path = 'TASKS/new-task.md';
    const task = createTaskData({ file, path: 'TASKS/new-task.md' });

    const base = createTaskInstance(task, { instanceId: 'base-inst', slotKey: 'none' });
    view.taskInstances = [base];
    view.tasks = [task];

    const duplicate = (await (view as unknown as {
      duplicateInstance: (inst: TaskInstance, returnOnly?: boolean) => Promise<TaskInstance | void>;
    }).duplicateInstance(base, true)) as TaskInstance;

    expect(duplicate).toBeDefined();
    expect(view.getCurrentDayState().duplicatedInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: duplicate.instanceId, originalPath: task.path }),
      ]),
    );

    await (view as unknown as { deleteInstance: (inst: TaskInstance) => Promise<void> }).deleteInstance(duplicate);

    const dayStateAfterDelete = view.getCurrentDayState();
    expect(dayStateAfterDelete.duplicatedInstances.find((d) => d.instanceId === duplicate.instanceId)).toBeUndefined();
    expect(dayStateAfterDelete.deletedInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: duplicate.instanceId, deletionType: 'temporary' }),
      ]),
    );

    view.taskInstances = [];
    view.tasks = [];

    const folder = { children: [file] };
    (view.app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === 'TASKS') return folder;
      if (path === file.path) return file;
      return null;
    });
    (view.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file]);
    (view.app.metadataCache.getFileCache as jest.Mock).mockImplementation((candidate: TFile) => {
      if (candidate === file) {
        return {
          frontmatter: {
            target_date: '2025-01-01',
          },
        };
      }
      return null;
    });
    (view.app.vault.read as jest.Mock).mockImplementation(async (candidate: TFile) => {
      if (candidate === file) {
        return '#task\n';
      }
      return '';
    });

    await (view as unknown as { loadTasks: () => Promise<void> }).loadTasks();

    const remaining = view.taskInstances.find((inst) => inst.task.path === task.path);
    expect(remaining).toBeDefined();
    expect(remaining?.instanceId).not.toBe(duplicate.instanceId);
  });

  test('deleteRoutineTask hides base routine and persists state', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const persistSpy = jest
      .spyOn(view as unknown as { persistDayState: (dateStr: string) => Promise<void> }, 'persistDayState')
      .mockResolvedValue(undefined);
    const deleteInstanceSpy = jest
      .spyOn(view.taskMutationService, 'deleteInstance')
      .mockResolvedValue(undefined);
    const deleteLogsSpy = jest
      .spyOn(view.taskMutationService, 'deleteTaskLogsByInstanceId')
      .mockResolvedValue(1);

    const task = createTaskData({ isRoutine: true, path: 'ROUTINE/base.md' });
    const instance = createTaskInstance(task, { instanceId: 'routine-1' });
    view.taskInstances = [instance];

    await (view as unknown as { deleteRoutineTask: (inst: TaskInstance) => Promise<void> }).deleteRoutineTask(instance);

    const hidden = view.dayStateManager.getHidden('2025-01-01');
    expect(hidden).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'ROUTINE/base.md', instanceId: null }),
      ])
    );
    expect(persistSpy).toHaveBeenCalledWith('2025-01-01');
    expect(deleteInstanceSpy).toHaveBeenCalledWith(instance);
    expect(deleteLogsSpy).toHaveBeenCalledWith('ROUTINE/base.md', 'routine-1');

    deleteLogsSpy.mockRestore();
    deleteInstanceSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test('deleteRoutineTask hides duplicated routine with instance-scoped entry', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const persistSpy = jest
      .spyOn(view as unknown as { persistDayState: (dateStr: string) => Promise<void> }, 'persistDayState')
      .mockResolvedValue(undefined);
    const deleteInstanceSpy = jest
      .spyOn(view.taskMutationService, 'deleteInstance')
      .mockResolvedValue(undefined);

    const task = createTaskData({ isRoutine: true, path: 'ROUTINE/base.md' });
    const duplicate = createTaskInstance(task, { instanceId: 'dup-1' });
    view.taskInstances = [duplicate];
    const dayState = view.getCurrentDayState();
    dayState.duplicatedInstances.push({
      instanceId: 'dup-1',
      originalPath: 'ROUTINE/base.md',
      slotKey: duplicate.slotKey,
      timestamp: Date.now(),
    });

    await (view as unknown as { deleteRoutineTask: (inst: TaskInstance) => Promise<void> }).deleteRoutineTask(duplicate);

    const hidden = view.dayStateManager.getHidden('2025-01-01');
    expect(hidden).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'ROUTINE/base.md', instanceId: 'dup-1' }),
      ])
    );
    expect(persistSpy).toHaveBeenCalledWith('2025-01-01');
    expect(deleteInstanceSpy).toHaveBeenCalledWith(duplicate);

    deleteInstanceSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test('hideRoutineInstanceForDate records permanent deletion keyed by taskId/path', async () => {
    const { view } = createView();
    const targetDate = '2025-01-02';
    await view.ensureDayStateForDate(targetDate);

    const task = createTaskData({ isRoutine: true, path: 'ROUTINE/base.md', taskId: 'routine-123' });
    const instance = createTaskInstance(task, { instanceId: 'routine-inst-1' });

    await (view as unknown as { hideRoutineInstanceForDate: (inst: TaskInstance, dateKey: string) => Promise<void> })
      .hideRoutineInstanceForDate(instance, targetDate);

    const dayState = view.dayStateManager.getStateFor(targetDate);
    expect(dayState.deletedInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deletionType: 'permanent',
          path: 'ROUTINE/base.md',
          taskId: 'routine-123',
        }),
      ]),
    );

    // New instanceId should still be considered deleted via taskId/path match
    const isDeleted = view.dayStateManager.isDeleted({
      instanceId: 'routine-inst-2',
      path: 'ROUTINE/base.md',
      taskId: 'routine-123',
      dateKey: targetDate,
    });
    expect(isDeleted).toBe(true);
  });

  test('hideRoutineInstanceForDate allows re-hide after restored deletion', async () => {
    const { view } = createView();
    const targetDate = '2025-01-03';
    await view.ensureDayStateForDate(targetDate);

    const task = createTaskData({ isRoutine: true, path: 'ROUTINE/base.md', taskId: 'routine-456' });
    const instance = createTaskInstance(task, { instanceId: 'routine-inst-1' });

    const dayState = view.dayStateManager.getStateFor(targetDate);
    dayState.deletedInstances.push({
      deletionType: 'permanent',
      path: 'ROUTINE/base.md',
      taskId: 'routine-456',
      deletedAt: 1000,
      restoredAt: 2000,
    });

    await (view as unknown as { hideRoutineInstanceForDate: (inst: TaskInstance, dateKey: string) => Promise<void> })
      .hideRoutineInstanceForDate(instance, targetDate);

    const isDeleted = view.dayStateManager.isDeleted({
      instanceId: 'routine-inst-2',
      path: 'ROUTINE/base.md',
      taskId: 'routine-456',
      dateKey: targetDate,
    });
    expect(isDeleted).toBe(true);
  });
});

describe('TaskChuteView persistSlotAssignment', () => {
  test('clears routine slot override when slot realigns with scheduled time', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    const dayState = view.getCurrentDayState();

    const routineTask = createTaskData({ isRoutine: true, path: 'ROUTINE/reset.md' });
    (routineTask as TaskData & { scheduledTime?: string }).scheduledTime = '08:15';
    dayState.slotOverrides[routineTask.path] = '12:00-16:00';

    const instance = createTaskInstance(routineTask, {
      instanceId: 'routine-reset',
      slotKey: '8:00-12:00',
    });

    (view as unknown as { persistSlotAssignment: (inst: TaskInstance) => void }).persistSlotAssignment(instance);

    expect(dayState.slotOverrides[routineTask.path]).toBeUndefined();
    expect(dayState.slotOverrides[routineTask.taskId!]).toBeUndefined();
  });

  test('persists non-routine slot assignment into day state overrides', async () => {
    const { view, plugin } = createView();
    await view.ensureDayStateForCurrentDate();
    const dayState = view.getCurrentDayState();

    const task = createTaskData({ isRoutine: false, path: 'TASKS/non-routine.md' });
    const instance = createTaskInstance(task, {
      instanceId: 'non-routine-slot',
      slotKey: '12:00-16:00',
    });

    (view as unknown as { persistSlotAssignment: (inst: TaskInstance) => void }).persistSlotAssignment(instance);

    expect(dayState.slotOverrides[task.taskId!]).toBe('12:00-16:00');
    expect(dayState.slotOverridesMeta?.[task.taskId!]?.slotKey).toBe('12:00-16:00');
    expect(plugin.settings.slotKeys[task.taskId!]).toBeUndefined();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  test('updates duplicated instance slot metadata when slot changes', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    const dayState = view.getCurrentDayState();

    const task = createTaskData({ isRoutine: true, path: 'TASKS/dup.md' });
    (task as TaskData & { scheduledTime?: string }).scheduledTime = '12:00';
    const instance = createTaskInstance(task, {
      instanceId: 'dup-slot',
      slotKey: '16:00-0:00',
    });
    dayState.duplicatedInstances.push({
      instanceId: 'dup-slot',
      originalPath: task.path,
      slotKey: '8:00-12:00',
    });

    (view as unknown as { persistSlotAssignment: (inst: TaskInstance) => void }).persistSlotAssignment(instance);

    const entry = dayState.duplicatedInstances.find((dup) => dup.instanceId === 'dup-slot');
    expect(entry?.slotKey).toBe('16:00-0:00');
  });
});

describe('TaskChuteView moveNonRoutineSlotOverrideToDate', () => {
  test('moves non-routine slot override from current date to target date', async () => {
    const { view, plugin } = createView();
    const sourceDate = view.getCurrentDateString();
    const targetDate = '2025-01-02';
    await view.ensureDayStateForCurrentDate();
    await view.getDayState(targetDate);

    const task = createTaskData({ isRoutine: false, path: 'TASKS/move-target.md' });
    const instance = createTaskInstance(task, {
      instanceId: 'move-target-instance',
      slotKey: '12:00-16:00',
    });

    const sourceState = view.dayStateManager.getStateFor(sourceDate);
    sourceState.slotOverrides[task.taskId!] = '12:00-16:00';
    sourceState.slotOverridesMeta = {
      ...(sourceState.slotOverridesMeta ?? {}),
      [task.taskId!]: {
        slotKey: '12:00-16:00',
        updatedAt: 1_000,
      },
    };

    await (view as unknown as {
      moveNonRoutineSlotOverrideToDate: (inst: TaskInstance, dateStr: string) => Promise<void>;
    }).moveNonRoutineSlotOverrideToDate(instance, targetDate);

    const targetState = view.dayStateManager.getStateFor(targetDate);
    expect(sourceState.slotOverrides[task.taskId!]).toBeUndefined();
    expect(sourceState.slotOverridesMeta?.[task.taskId!]?.updatedAt).toBeGreaterThan(1_000);
    expect(targetState.slotOverrides[task.taskId!]).toBe('12:00-16:00');
    expect(targetState.slotOverridesMeta?.[task.taskId!]?.slotKey).toBe('12:00-16:00');
    expect(plugin.dayStateService.saveDay).toHaveBeenCalledTimes(2);
  });
});


describe('TaskChuteView loadTasksRefactored routines', () => {
  test('skips routines hidden via dayState hiddenRoutines', async () => {
    const { context, dayState, routinePath, load } = createRoutineLoadContext();
    context.isInstanceHidden = jest.fn((instanceId: string, path: string) =>
      dayState.hiddenRoutines.some((hidden: HiddenRoutine | string) => {
        if (typeof hidden === 'string') return hidden === path;
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      }),
    );
    dayState.hiddenRoutines.push({ path: routinePath, instanceId: null });

    await load();

    expect(context.taskInstances).toHaveLength(0);
    expect(context.tasks).toHaveLength(1);
    expect(context.tasks[0].path).toBe(routinePath);
  });

  test('renders routine when hidden entry is instance-scoped and differs', async () => {
    const { context, dayState, routinePath, load } = createRoutineLoadContext();
    context.isInstanceHidden = jest.fn((instanceId: string, path: string) =>
      dayState.hiddenRoutines.some((hidden: HiddenRoutine | string) => {
        if (typeof hidden === 'string') return hidden === path;
        if (!hidden) return false;
        if (hidden.instanceId && hidden.instanceId === instanceId) return true;
        if (hidden.instanceId === null && hidden.path === path) return true;
        return false;
      }),
    );
    dayState.hiddenRoutines.push({ path: routinePath, instanceId: 'other-instance' });

    await load();

    expect(context.taskInstances).toHaveLength(1);
    expect(context.taskInstances[0].task.path).toBe(routinePath);
  });

  test('adds duplicated routine instance when visible', async () => {
    const duplicatedRecord = {
      instanceId: 'dup-visible',
      originalPath: 'TASKS/routine.md',
      slotKey: '12:00-16:00',
      timestamp: 20,
    };
    const { context, load } = createRoutineLoadContext({
      duplicatedInstances: [duplicatedRecord],
    });
    context.generateInstanceId.mockImplementationOnce(() => 'routine-base');

    await load();

    const instanceIds = context.taskInstances.map((inst) => inst.instanceId);
    expect(instanceIds).toEqual(expect.arrayContaining(['routine-base', 'dup-visible']));
    const duplicate = context.taskInstances.find((inst) => inst.instanceId === 'dup-visible');
    expect(duplicate?.slotKey).toBe('12:00-16:00');
    expect(duplicate?.task.path).toBe('TASKS/routine.md');
  });

  test('skips duplicated routine when hidden entry targets instance', async () => {
    const duplicatedRecord = {
      instanceId: 'dup-hidden',
      originalPath: 'TASKS/routine.md',
      slotKey: '16:00-20:00',
      timestamp: 25,
    };
    const { context, dayState, load, routinePath } = createRoutineLoadContext({
      duplicatedInstances: [duplicatedRecord],
      hiddenRoutines: [{ path: 'TASKS/routine.md', instanceId: 'dup-hidden' }],
    });
    context.generateInstanceId.mockImplementationOnce(() => 'routine-base');

    await load();

    const instanceIds = context.taskInstances.map((inst) => inst.instanceId);
    expect(instanceIds).toContain('routine-base');
    expect(instanceIds).not.toContain('dup-hidden');
    expect(dayState.hiddenRoutines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: routinePath, instanceId: 'dup-hidden' }),
      ]),
    );
  });
});

describe('TaskChuteView loadTasksRefactored projects', () => {
  test('hydrates project metadata from frontmatter', async () => {
    const { context, load } = createNonRoutineLoadContext({
      metadataOverrides: {
        project: '[[Project Foo]]',
      },
    });

    await load();

    expect(context.tasks).toHaveLength(1);
    expect(context.tasks[0].project).toBe('[[Project Foo]]');
  });
});

describe('TaskChuteView loadTasksRefactored deletions', () => {
  test('skips permanently deleted non-routine tasks', async () => {
    const { context, load } = createNonRoutineLoadContext({ deletionType: 'permanent' });

    await load();

    expect(context.taskInstances).toHaveLength(0);
    expect(context.tasks).toHaveLength(0);
  });

  test('includes non-routine task when deletion is temporary', async () => {
    const { context, load } = createNonRoutineLoadContext({ deletionType: 'temporary' });

    await load();

    expect(context.taskInstances).toHaveLength(1);
    expect(context.tasks).toHaveLength(1);
  });
});

describe('TaskChuteView loadTasksRefactored executions', () => {
  test('creates synthetic task instances from execution log entries', async () => {
    const startTime = '2025-09-24T01:00:00.000Z'
    const { context, load } = createExecutionLogContext({
      executions: [
        {
          taskTitle: 'Logged Task',
          taskPath: 'TASKS/logged.md',
          slotKey: '10:00-12:00',
          instanceId: 'exec-visible',
          startTime,
        },
      ],
    });

    await load();

    expect(context.tasks).toHaveLength(1);
    expect(context.taskInstances).toHaveLength(1);
    const instance = context.taskInstances[0];
    expect(instance.instanceId).toBe('exec-visible');
    // Invalid slotKey is recalculated from startTime using local-time conversion.
    expect(instance.slotKey).toBe(context.getSectionConfig().getCurrentTimeSlot(new Date(startTime)));
    expect(instance.state).toBe('done');
    expect(instance.task.displayTitle).toBe('Logged Task');
  });

  test('omits execution log entries hidden via permanent deletions', async () => {
    const { context, load } = createExecutionLogContext({
      executions: [
        {
          taskTitle: 'Keep Task',
          taskPath: 'TASKS/keep.md',
          slotKey: '08:00-09:00',
          instanceId: 'exec-keep',
          startTime: '2025-09-24T00:30:00.000Z',
        },
        {
          taskTitle: 'Hidden Task',
          taskPath: 'TASKS/hidden.md',
          slotKey: '09:00-10:00',
          instanceId: 'exec-hidden',
          startTime: '2025-09-24T00:45:00.000Z',
        },
      ],
      deletedInstances: [
        {
          path: 'TASKS/hidden.md',
          deletionType: 'permanent',
          timestamp: 123,
        },
      ],
    });

    await load();

    const ids = context.taskInstances.map((inst) => inst.instanceId);
    expect(ids).toContain('exec-keep');
    expect(ids).not.toContain('exec-hidden');
    expect(context.tasks.map((task) => task.path)).toEqual([
      'TASKS/keep.md',
    ]);
  });

  test('restores duplicated day-state instances after execution log merge', async () => {
    const executionInstance = {
      taskTitle: 'Logged Task',
      taskPath: 'TASKS/logged.md',
      slotKey: '8:00-12:00',
      instanceId: 'exec-visible',
      startTime: '2025-09-24T00:00:00.000Z',
    };

    const duplicatedRecord = {
      instanceId: 'dup-visible',
      originalPath: 'TASKS/logged.md',
      slotKey: '16:00-0:00',
      originalSlotKey: '8:00-12:00',
    };

    const { context, load } = createExecutionLogContext({
      executions: [executionInstance],
      duplicatedInstances: [duplicatedRecord],
      taskFiles: [
        {
          path: 'TASKS/logged.md',
          frontmatter: {
            title: 'Logged Task',
            isRoutine: false,
            scheduled_time: '08:00',
          },
          content: '#task\n',
        },
      ],
    });

    await load();

    const ids = context.taskInstances.map((inst) => inst.instanceId);
    expect(ids).toContain('exec-visible');
    expect(ids).toContain('dup-visible');

    const duplicate = context.taskInstances.find((inst) => inst.instanceId === 'dup-visible');
    expect(duplicate).toBeDefined();
    expect(duplicate?.slotKey).toBe('16:00-0:00');
    expect(duplicate?.task.path).toBe('TASKS/logged.md');
    expect(duplicate?.task.displayTitle).toBe('Logged Task');

    const primary = context.taskInstances.find((inst) => inst.instanceId === 'exec-visible');
    expect(primary).toBeDefined();
    expect(primary?.slotKey).toBe('8:00-12:00');
  });

  test('skips duplicated instances suppressed via hidden routine metadata', async () => {
    const executionInstance = {
      taskTitle: 'Logged Task',
      taskPath: 'TASKS/logged.md',
      slotKey: '08:00-09:00',
      instanceId: 'exec-visible',
      startTime: '2025-09-24T01:00:00.000Z',
    };

    const duplicatedRecord = {
      instanceId: 'dup-hidden',
      originalPath: 'TASKS/logged.md',
      slotKey: '16:00-17:00',
      originalSlotKey: '08:00-09:00',
    };

    const hiddenRoutine = {
      path: 'TASKS/logged.md',
      instanceId: 'dup-hidden',
      date: '2025-09-24',
    } as HiddenRoutine;

    const { context, load } = createExecutionLogContext({
      executions: [executionInstance],
      duplicatedInstances: [duplicatedRecord],
      hiddenRoutines: [hiddenRoutine],
      taskFiles: [
        {
          path: 'TASKS/logged.md',
          frontmatter: {
            title: 'Logged Task',
            isRoutine: false,
            scheduled_time: '08:00',
          },
          content: '#task\n',
        },
      ],
    });

    await load();

    const ids = context.taskInstances.map((inst) => inst.instanceId);
    expect(ids).toContain('exec-visible');
    expect(ids).not.toContain('dup-hidden');
  });

  test('restores duplicated instance with fallback metadata when file missing', async () => {
    const { context, load } = createExecutionLogContext({
      executions: [],
      duplicatedInstances: [
        {
          instanceId: 'dup-fallback',
          originalPath: 'TASKS/missing.md',
          slotKey: 'none',
        },
      ],
    });

    await load();

    const duplicate = context.taskInstances.find((inst) => inst.instanceId === 'dup-fallback');
    expect(duplicate).toBeDefined();
    expect(duplicate?.task.path).toBe('TASKS/missing.md');
    expect(duplicate?.task.displayTitle).toBe('missing');
    expect(duplicate?.slotKey).toBe('none');
  });
});

describe('TaskChuteView running task restore', () => {
  test('restores matching instance and resumes timer', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/base.md', name: 'Base' });
    const instance = createTaskInstance(task, {
      instanceId: 'run-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    });
    view.taskInstances = [instance];
    view.tasks = [task];

    const restoreForDateMock = jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockImplementation(async (opts) => {
        const instances = opts?.instances ?? []
        if (!instances.length) return []
        const target = instances[0]
        target.state = 'running'
        target.slotKey = '12:00-16:00'
        target.originalSlotKey = '8:00-12:00'
        target.startTime = new Date('2025-01-01T04:00:00.000Z')
        return [target]
      })

    const startGlobalTimer = jest.fn();
    const renderTaskList = jest.fn();
    (view as unknown as { startGlobalTimer: () => void }).startGlobalTimer = startGlobalTimer;
    view.renderTaskList = renderTaskList;

    await view.restoreRunningTaskState();

    expect(restoreForDateMock).toHaveBeenCalledWith(
      expect.objectContaining({ dateString: '2025-01-01' }),
    )
    expect(instance.state).toBe('running');
    expect(instance.slotKey).toBe('12:00-16:00');
    expect(instance.originalSlotKey).toBe('8:00-12:00');
    expect(instance.startTime?.toISOString()).toBe('2025-01-01T04:00:00.000Z');
    expect(view.currentInstance).toBe(instance);
    expect(startGlobalTimer).toHaveBeenCalled();
    expect(renderTaskList).toHaveBeenCalled();
  });

  test('restores path-matched idle instance with new id', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/base.md', name: 'Base' });
    const instance = createTaskInstance(task, {
      instanceId: 'old-id',
      state: 'idle',
      slotKey: '8:00-12:00',
    });
    view.taskInstances = [instance];
    view.tasks = [task];

    const restoreForDateMock = jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockImplementation(async (opts) => {
        const instances = opts?.instances ?? []
        if (!instances.length) return []
        const target = instances[0]
        target.state = 'running'
        target.slotKey = '12:00-16:00'
        target.originalSlotKey = '8:00-12:00'
        target.startTime = new Date('2025-01-01T04:30:00.000Z')
        target.instanceId = 'new-id'
        return [target]
      })

    const startGlobalTimer = jest.fn();
    const renderTaskList = jest.fn();
    (view as unknown as { startGlobalTimer: () => void }).startGlobalTimer = startGlobalTimer;
    view.renderTaskList = renderTaskList;

    await view.restoreRunningTaskState();

    expect(restoreForDateMock).toHaveBeenCalledWith(
      expect.objectContaining({ dateString: '2025-01-01' }),
    )
    expect(instance.instanceId).toBe('new-id');
    expect(instance.state).toBe('running');
    expect(instance.slotKey).toBe('12:00-16:00');
    expect(instance.originalSlotKey).toBe('8:00-12:00');
    expect(instance.startTime?.toISOString()).toBe('2025-01-01T04:30:00.000Z');
    expect(view.currentInstance).toBe(instance);
    expect(startGlobalTimer).toHaveBeenCalled();
    expect(renderTaskList).toHaveBeenCalled();
  });

  test('skips restoring permanently deleted tasks', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/deleted.md', name: 'Deleted' });
    const instance = createTaskInstance(task, {
      instanceId: 'del-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    });
    view.taskInstances = [instance];
    view.tasks = [task];

    const dayState = view.getCurrentDayState();
    dayState.deletedInstances.push({
      path: 'TASKS/deleted.md',
      deletionType: 'permanent',
      timestamp: Date.now(),
    });

    jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockResolvedValue([])

    const startGlobalTimer = jest.fn();
    (view as unknown as { startGlobalTimer: () => void }).startGlobalTimer = startGlobalTimer;
    view.renderTaskList = jest.fn();

    await view.restoreRunningTaskState();

    expect(instance.state).toBe('idle');
    expect(instance.slotKey).toBe('8:00-12:00');
    expect(view.currentInstance).toBeNull();
    expect(startGlobalTimer).not.toHaveBeenCalled();
  });

  test('treats legacy permanent deletions as deleted when restoring running tasks', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/legacy-deleted.md', name: 'LegacyDeleted' });
    const instance = createTaskInstance(task, {
      instanceId: 'legacy-del-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    });
    view.taskInstances = [instance];
    view.tasks = [task];

    const dayState = view.getCurrentDayState();
    dayState.deletedInstances.push({
      path: 'TASKS/legacy-deleted.md',
      deletionType: 'permanent',
    });

    const restoreForDateMock = jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockResolvedValue([]);

    await view.restoreRunningTaskState();

    const restoreOptions = restoreForDateMock.mock.calls[0]?.[0];
    expect(restoreOptions?.deletedPaths).toContain('TASKS/legacy-deleted.md');
  });

  test('restores running tasks when deletion was already restored', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/restored.md', name: 'Restored' });
    const instance = createTaskInstance(task, {
      instanceId: 'restored-1',
      state: 'idle',
      slotKey: '8:00-12:00',
    });
    view.taskInstances = [instance];
    view.tasks = [task];

    const dayState = view.getCurrentDayState();
    dayState.deletedInstances.push({
      path: 'TASKS/restored.md',
      deletionType: 'permanent',
      deletedAt: 1000,
      restoredAt: 2000,
    });

    const restoreForDateMock = jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockResolvedValue([instance]);

    const startGlobalTimer = jest.fn();
    (view as unknown as { startGlobalTimer: () => void }).startGlobalTimer = startGlobalTimer;
    view.renderTaskList = jest.fn();

    await view.restoreRunningTaskState();

    const restoreOptions = restoreForDateMock.mock.calls[0]?.[0];
    expect(restoreOptions?.deletedPaths).not.toContain('TASKS/restored.md');
  });

  test('recreates running instance when none exists', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/missing.md', name: 'Missing' });
    view.tasks = [task];
    view.taskInstances = [];

    jest.spyOn(view, 'generateInstanceId').mockImplementation(() => 'missing-1')

    jest
      .spyOn(view.runningTasksService, 'restoreForDate')
      .mockImplementation(async (opts) => {
        const instances = opts?.instances ?? []
        const findTaskByPath = opts?.findTaskByPath ?? (() => undefined)
        const generateInstanceId = opts?.generateInstanceId ?? (() => 'missing-1')
        const taskData = findTaskByPath('TASKS/missing.md')
        if (!taskData) return []
        instances.push({
          task: taskData,
          instanceId: generateInstanceId(taskData),
          state: 'running',
          slotKey: '12:00-16:00',
          originalSlotKey: '8:00-12:00',
          startTime: new Date('2025-01-01T06:00:00.000Z'),
          stopTime: undefined,
        } as TaskInstance)
        return instances.slice(-1)
      })

    const startGlobalTimer = jest.fn();
    const renderTaskList = jest.fn();
    (view as unknown as { startGlobalTimer: () => void }).startGlobalTimer = startGlobalTimer;
    view.renderTaskList = renderTaskList;

    await view.restoreRunningTaskState();

    expect(view.taskInstances).toHaveLength(1);
    const recreated = view.taskInstances[0];
    expect(recreated.task.path).toBe('TASKS/missing.md');
    expect(recreated.instanceId).toBe('missing-1');
    expect(recreated.state).toBe('running');
    expect(recreated.slotKey).toBe('12:00-16:00');
    expect(recreated.originalSlotKey).toBe('8:00-12:00');
    expect(recreated.startTime?.toISOString()).toBe('2025-01-01T06:00:00.000Z');
    expect(view.currentInstance).toBe(recreated);
    expect(startGlobalTimer).toHaveBeenCalled();
    expect(renderTaskList).toHaveBeenCalled();
  });
});

describe('TaskChuteView deleted task restore candidate', () => {
  test('excludes restored deletion entries from restore candidates', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const dayState = view.getCurrentDayState();
    dayState.deletedInstances.push({
      path: 'TASKS/restore.md',
      deletionType: 'permanent',
      deletedAt: 1000,
      restoredAt: 2000,
    });

    const candidate = (view as unknown as {
      findDeletedTaskRestoreCandidate: (taskName: string) => { entry: unknown } | null
    }).findDeletedTaskRestoreCandidate('restore');

    expect(candidate).toBeNull();
  });

  test('includes legacy deletion entries without timestamps as restore candidates', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const dayState = view.getCurrentDayState();
    dayState.deletedInstances.push({
      path: 'TASKS/legacy.md',
      deletionType: 'permanent',
    });

    const candidate = (view as unknown as {
      findDeletedTaskRestoreCandidate: (taskName: string) => { entry: { path?: string } } | null
    }).findDeletedTaskRestoreCandidate('legacy');

    expect(candidate).not.toBeNull();
    expect(candidate?.entry.path).toBe('TASKS/legacy.md');
  });
});

describe('TaskChuteView navigation overlay', () => {
  test('toggleNavigation opens and closes panel with overlay classes', () => {
    const { view } = createView();
    const panel = document.createElement('div');
    panel.classList.add('navigation-panel-hidden');
    const overlay = document.createElement('div');
    overlay.classList.add('navigation-overlay-hidden');

    (view as Mutable<TaskChuteView>).navigationPanel = panel;
    (view as Mutable<TaskChuteView>).navigationOverlay = overlay;

    expect(view['navigationState'].isOpen).toBe(false);

    view.navigationController.toggleNavigation();

    expect(view['navigationState'].isOpen).toBe(true);
    expect(panel.classList.contains('navigation-panel-hidden')).toBe(false);
    expect(overlay.classList.contains('navigation-overlay-hidden')).toBe(false);

    view.navigationController.toggleNavigation();

    expect(view['navigationState'].isOpen).toBe(false);
    expect(panel.classList.contains('navigation-panel-hidden')).toBe(true);
    expect(overlay.classList.contains('navigation-overlay-hidden')).toBe(true);
  });

  test('closeNavigation reapplies hidden classes', () => {
    const { view } = createView();

    const contentContainer = document.createElement('div');
    attachRecursiveCreateEl(contentContainer);

    view.navigationController.createNavigationUI(contentContainer as CreateElCapableElement);
    view.navigationState.isOpen = true;
    view.navigationController.openNavigation();

    expect(view.navigationOverlay.classList.contains('navigation-overlay-hidden')).toBe(false);
    expect(view.navigationPanel.classList.contains('navigation-panel-hidden')).toBe(false);

    view.navigationController.closeNavigation();

    expect(view.navigationOverlay.classList.contains('navigation-overlay-hidden')).toBe(true);
    expect(view.navigationPanel.classList.contains('navigation-panel-hidden')).toBe(true);
  });
});

describe('TaskChuteView navigation listeners', () => {
  test('overlay click triggers closeNavigation listener', () => {
    const { view } = createView();
    const overlay = document.createElement('div');
    overlay.classList.add('navigation-overlay');
    view.containerEl.appendChild(overlay);

    const panel = document.createElement('div');
    panel.classList.add('navigation-panel');
    (view as Mutable<TaskChuteView>).navigationOverlay = overlay;
    (view as Mutable<TaskChuteView>).navigationPanel = panel;

    (view as Mutable<TaskChuteView>).registerDomEvent = (target, event, handler) => {
      target.addEventListener(event as string, handler as EventListener);
    };

    const closeSpy = jest.spyOn(view.navigationController as { closeNavigation: () => void }, 'closeNavigation');

    view.navigationController.initializeNavigationEventListeners();

    overlay.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TaskChuteView navigation commands', () => {
  beforeEach(() => {
    MockedRoutineManagerModal.mockClear();
  });

  test('log section opens modal and closes navigation', async () => {
    document.querySelectorAll('.taskchute-log-modal-overlay').forEach((overlay) => overlay.remove());
    const { view } = createView();
    await view.navigationController.handleNavigationItemClick('log');

    expect(MockedLogView).toHaveBeenCalledTimes(1);
    expect(view.navigationState.isOpen).toBe(false);
    const overlay = document.querySelector('.taskchute-log-modal-overlay');
    expect(overlay).not.toBeNull();
    overlay?.remove();
    MockedLogView.mockClear();
  });

  test('review section invokes ReviewService and closes navigation', async () => {
    const { view } = createView();
    MockedReviewService.mockClear();
    await view.navigationController.handleNavigationItemClick('review');

    expect(MockedReviewService).toHaveBeenCalledTimes(1);
    const serviceInstance = MockedReviewService.mock.results[0]?.value;
    expect(serviceInstance.ensureReviewFile).toHaveBeenCalledTimes(1);
    expect(serviceInstance.openInSplit).toHaveBeenCalledTimes(1);
    expect(view.navigationState.isOpen).toBe(false);
  });

  test('routine section opens RoutineManagerModal and closes navigation', async () => {
    const { view } = createView();
    const closeNavigation = jest
      .spyOn(view.navigationController as { closeNavigation: () => void }, 'closeNavigation')
      .mockImplementation(() => undefined);

    const mockInstance = { open: jest.fn() };
    MockedRoutineManagerModal.mockImplementationOnce(() => mockInstance as unknown as RoutineManagerModal);

    await view.navigationController.handleNavigationItemClick('routine');

    expect(MockedRoutineManagerModal).toHaveBeenCalledTimes(1);
    expect(mockInstance.open).toHaveBeenCalledTimes(1);
    expect(closeNavigation).toHaveBeenCalledTimes(1);
  });

  test('settings section opens plugin settings and closes navigation', async () => {
    const { view, plugin } = createView();
    const closeNavigation = jest
      .spyOn(view.navigationController as { closeNavigation: () => void }, 'closeNavigation')
      .mockImplementation(() => undefined);
    const open = jest.spyOn(plugin.app.setting, 'open');
    const openTabById = jest.spyOn(plugin.app.setting, 'openTabById');

    await view.navigationController.handleNavigationItemClick('settings');

    expect(open).toHaveBeenCalledTimes(1);
    expect(openTabById).toHaveBeenCalledWith('taskchute-plus');
    expect(closeNavigation).toHaveBeenCalledTimes(1);
  });
});

describe('TaskChuteView keyboard selection helpers', () => {
  test('selectTaskForKeyboard marks instance and element', () => {
    const { view } = createView();
    const selection = view['taskSelectionController'];
    const task = createTaskData({ path: 'TASKS/keyboard.md' });
    const instance = createTaskInstance(task, { instanceId: 'keyboard-1' });

    const taskItem = document.createElement('div');
    taskItem.classList.add('task-item');
    view.containerEl.appendChild(taskItem);

    selection.select(instance, taskItem);

    expect(selection.getSelectedInstance()).toBe(instance);
    expect(taskItem.classList.contains('keyboard-selected')).toBe(true);
  });

  test('clear removes highlight and resets selection', () => {
    const { view } = createView();
    const selection = view['taskSelectionController'];
    const first = document.createElement('div');
    first.classList.add('task-item');
    const second = document.createElement('div');
    second.classList.add('task-item');
    view.containerEl.appendChild(first);
    view.containerEl.appendChild(second);

    const instance = createTaskInstance(createTaskData(), { instanceId: 'keyboard-clear' });
    selection.select(instance, first);
    selection.select(instance, second);

    selection.clear();

    expect(selection.getSelectedInstance()).toBeNull();
    expect(first.classList.contains('keyboard-selected')).toBe(false);
    expect(second.classList.contains('keyboard-selected')).toBe(false);
  });
});

describe('TaskChuteView execution log integration', () => {
  test('stopInstance persists log and recomputes duration', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/logged.md', name: 'Logged' });
    const instance = createTaskInstance(task, {
      instanceId: 'running-1',
      state: 'running',
      startTime: new Date('2025-01-01T08:00:00.000Z'),
    });
    view.taskInstances = [instance];

    const saveTaskLog = jest.fn().mockResolvedValue(undefined);
    (view as Mutable<TaskChuteView>).executionLogService = {
      saveTaskLog,
      removeTaskLogForInstanceOnDate: jest.fn(),
    } as unknown as TaskChuteView['executionLogService'];

    jest
      .spyOn(view as unknown as { calculateCrossDayDuration: (start: Date, stop: Date) => number }, 'calculateCrossDayDuration')
      .mockReturnValue(3_600_000);
    const saveRunningSpy = jest
      .spyOn(view as unknown as { saveRunningTasksState: () => Promise<void> }, 'saveRunningTasksState')
      .mockResolvedValue(undefined);
    const sortSpy = jest
      .spyOn(view as unknown as { sortTaskInstancesByTimeOrder: () => void }, 'sortTaskInstancesByTimeOrder')
      .mockImplementation(() => undefined);
    const saveOrdersSpy = jest
      .spyOn(view as unknown as { saveTaskOrders: () => Promise<void> }, 'saveTaskOrders')
      .mockResolvedValue(undefined);
    const renderSpy = jest
      .spyOn(view, 'renderTaskList')
      .mockImplementation(() => undefined);
    (view as Mutable<TaskChuteView>).timerService = {
      restart: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    } as unknown as TaskChuteView['timerService'];

    const stopMethod = view as unknown as { stopInstance: (inst: TaskInstance) => Promise<void> };
    await stopMethod.stopInstance(instance);

    expect(instance.state).toBe('done');
    expect(instance.actualMinutes).toBe(60);
    expect(saveTaskLog).toHaveBeenCalledWith(instance, 3600);
    expect(saveRunningSpy).toHaveBeenCalled();
    expect(sortSpy).toHaveBeenCalled();
    expect(saveOrdersSpy).toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
    expect(mockedHeatmapService).toHaveBeenCalled();

    mockedHeatmapService.mockClear();
  });

  test('stopInstance does not restart timer on past-date view', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-02T12:00:00.000Z'))

    try {
      const { view } = createView();
      const stopSpy = jest.fn().mockResolvedValue(undefined)
      ;(view as Mutable<TaskChuteView>).taskExecutionService = {
        stopInstance: stopSpy,
      } as unknown as TaskChuteView['taskExecutionService']
      const timerRestart = jest.fn()
      ;(view as Mutable<TaskChuteView>).timerService = {
        restart: timerRestart,
        start: jest.fn(),
        stop: jest.fn(),
      } as unknown as TaskChuteView['timerService']

      const instance = createTaskInstance(createTaskData(), {
        state: 'running',
        startTime: new Date('2025-01-01T08:00:00.000Z'),
      })

      await view.stopInstance(instance)

      expect(stopSpy).toHaveBeenCalledWith(instance, undefined)
      expect(timerRestart).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  });

  test('resetTaskToIdle removes execution log entry for current date', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const task = createTaskData({ path: 'TASKS/reset.md', name: 'Resettable' });
    const instance = createTaskInstance(task, {
      instanceId: 'idle-reset',
      state: 'done',
      startTime: new Date('2025-01-01T04:00:00.000Z'),
      stopTime: new Date('2025-01-01T05:00:00.000Z'),
    });

    view.taskInstances = [instance];
    view.currentInstance = instance;

    const removeTaskLogForInstanceOnDate = jest.fn().mockResolvedValue(undefined);
    (view as Mutable<TaskChuteView>).executionLogService = {
      saveTaskLog: jest.fn(),
      removeTaskLogForInstanceOnDate,
    } as unknown as TaskChuteView['executionLogService'];

    const saveRunningSpy = jest
      .spyOn(view as unknown as { saveRunningTasksState: () => Promise<void> }, 'saveRunningTasksState')
      .mockResolvedValue(undefined);
    const renderSpy = jest
      .spyOn(view, 'renderTaskList')
      .mockImplementation(() => undefined);

    await (view as unknown as { resetTaskToIdle: (inst: TaskInstance) => Promise<void> }).resetTaskToIdle(instance);

    expect(instance.state).toBe('idle');
    expect(instance.startTime).toBeUndefined();
    expect(instance.stopTime).toBeUndefined();
    expect(removeTaskLogForInstanceOnDate).toHaveBeenCalledWith(
      'idle-reset',
      '2025-01-01',
      task.taskId,
      task.path,
    );
    expect(saveRunningSpy).toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalled();
  });
});

describe('TaskChuteView registerDomEvent harness', () => {
  test('setupEventListeners wires container click handler', () => {
    const { view } = createView();
    view.containerEl = document.createElement('div');

    const registerDomEvent = jest.fn();
    (view as Mutable<TaskChuteView>).registerDomEvent = registerDomEvent;
    const registerEvent = jest.fn();
    (view as Mutable<TaskChuteView>).registerEvent = registerEvent;

    const containerRemoveSpy = jest.spyOn(view.containerEl, 'removeEventListener');
    const renameDetach = jest.fn();
    (view.app.vault.on as jest.Mock).mockReturnValue({ detach: renameDetach });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    expect(registerDomEvent).toHaveBeenCalledTimes(1);
    const calls = registerDomEvent.mock.calls.map(([target, event]) => ({ target, event }));
    const hasContainerClick = calls.some(({ target, event }) => target === view.containerEl && event === 'click');
    expect(hasContainerClick).toBe(true);
    expect(registerEvent).toHaveBeenCalledWith(expect.objectContaining({ detach: expect.any(Function) }));
    expect((view.app.vault.on as jest.Mock).mock.calls[0][0]).toBe('rename');

    const managed = (view as Mutable<TaskChuteView>)['managedDisposers'];
    expect(managed.length).toBeGreaterThanOrEqual(2);
    managed.slice().forEach((dispose) => dispose());

    expect(containerRemoveSpy).toHaveBeenCalled();
    expect(renameDetach).toHaveBeenCalled();

    containerRemoveSpy.mockRestore();
  });

  test('renderTaskList registers managed handlers for task rows', () => {
    const { view } = createView();
    const registerDomEvent = jest.fn();
    (view as Mutable<TaskChuteView>).registerDomEvent = registerDomEvent;

    view.taskList = document.createElement('div');
    attachRecursiveCreateEl(view.taskList);
    const instance = createTaskInstance(createTaskData({ path: 'TASKS/item.md' }), {
      instanceId: 'task-1',
    });
    view.taskInstances = [instance];

    view.renderTaskList();

    expect(registerDomEvent).toHaveBeenCalled();
    const events = registerDomEvent.mock.calls.map(([, event]) => event);
    expect(events).toEqual(expect.arrayContaining(['contextmenu', 'click', 'dragover', 'dragleave', 'drop']));
  });
});

describe('TaskChuteView state file modify listener', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('reloads and restores on external state file modification', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);

    const consumeSpy = jest.fn(() => false);
    (plugin.dayStateService as unknown as { consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean }).consumeLocalStateWrite = consumeSpy;

    // Mock vault.read for hash-based content detection
    (view.app.vault.read as jest.Mock).mockResolvedValue('{"days":{}}');

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    expect(modifyHandler).not.toBeNull();
    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    // Flush async vault.read and promise microtasks
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);

    expect(consumeSpy).toHaveBeenCalledWith('LOGS/2025-01-state.json', '{"days":{}}', expect.any(Number));
    expect(reloadSpy).toHaveBeenCalledWith({ runBoundaryCheck: false, clearDayStateCache: 'all' });
  });

  test('processes multiple state file modifications within debounce window', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');

    const mergeSpy = jest.fn(async (monthKey: string) => {
      if (monthKey === '2025-01') {
        return { merged: {}, affectedDateKeys: ['2025-01-01'] };
      }
      if (monthKey === '2024-12') {
        return { merged: {}, affectedDateKeys: ['2024-12-31'] };
      }
      return { merged: {}, affectedDateKeys: [] };
    });

    (plugin.dayStateService as unknown as {
      consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean;
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).consumeLocalStateWrite = jest.fn(() => false);
    (plugin.dayStateService as unknown as {
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).getMonthKeyFromPath = jest.fn((path: string) => {
      if (path.includes('2025-01')) return '2025-01';
      if (path.includes('2024-12')) return '2024-12';
      return null;
    });
    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    // Mock vault.read for hash-based content detection
    (view.app.vault.read as jest.Mock).mockResolvedValue('{"days":{}}');

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    expect(modifyHandler).not.toBeNull();
    const fileA = new TFile();
    fileA.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(fileA, TFile.prototype);
    modifyHandler?.(fileA);

    // Flush async vault.read for first file
    await Promise.resolve();
    await Promise.resolve();

    const fileB = new TFile();
    fileB.path = 'LOGS/2024-12-state.json';
    Object.setPrototypeOf(fileB, TFile.prototype);
    modifyHandler?.(fileB);

    // Flush async vault.read for second file
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    const mergedMonths = mergeSpy.mock.calls.map((call) => call[0]);
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect(mergedMonths).toEqual(expect.arrayContaining(['2025-01', '2024-12']));
    expect(clearSpy).toHaveBeenCalledWith('2025-01-01');
    expect(clearSpy).toHaveBeenCalledWith('2024-12-31');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledWith({ runBoundaryCheck: false, clearDayStateCache: 'none' });
  });

  test('queues debounced external change when barrier starts before timer fires', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: ['2025-01-01'] }));

    (plugin.dayStateService as unknown as {
      consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean;
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).consumeLocalStateWrite = jest.fn(() => false);
    (plugin.dayStateService as unknown as {
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).getMonthKeyFromPath = jest.fn(() => '2025-01');
    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view.app.vault.read as jest.Mock).mockResolvedValue('{"days":{}}');

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    expect(modifyHandler).not.toBeNull();
    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    await Promise.resolve();
    await Promise.resolve();

    view.dayStateManager.beginWriteBarrier();

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();

    const pending = view as unknown as {
      pendingReloadAfterBarrier: boolean;
      pendingExternalMergeMonthKeys: Set<string>;
    };
    expect(pending.pendingReloadAfterBarrier).toBe(true);
    expect(Array.from(pending.pendingExternalMergeMonthKeys)).toEqual(['2025-01']);

    await view.dayStateManager.endWriteBarrier();
    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(mergeSpy).toHaveBeenCalledWith('2025-01');
    expect(clearSpy).toHaveBeenCalledWith('2025-01-01');
    expect(reloadSpy).toHaveBeenCalledWith({ runBoundaryCheck: false, clearDayStateCache: 'none' });
  });

  test('clears debounce pending state when view starts closing before timer fires', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: ['2025-01-01'] }));

    (plugin.dayStateService as unknown as {
      consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean;
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).consumeLocalStateWrite = jest.fn(() => false);
    (plugin.dayStateService as unknown as {
      getMonthKeyFromPath?: (path: string) => string | null;
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).getMonthKeyFromPath = jest.fn(() => '2025-01');
    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view.app.vault.read as jest.Mock).mockResolvedValue('{"days":{}}');

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(modifyHandler).not.toBeNull();

    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    await Promise.resolve();
    await Promise.resolve();

    (view as unknown as { isClosingOrClosed: boolean }).isClosingOrClosed = true;

    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    const pendingState = view as unknown as {
      stateFileModifyPendingMonthKeys: Set<string>;
      stateFileModifyRequiresFullReload: boolean;
    };
    expect(pendingState.stateFileModifyPendingMonthKeys.size).toBe(0);
    expect(pendingState.stateFileModifyRequiresFullReload).toBe(false);
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test('ignores local state file modifications', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);

    const consumeSpy = jest.fn(() => true);
    (plugin.dayStateService as unknown as { consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean }).consumeLocalStateWrite = consumeSpy;

    // Mock vault.read for hash-based content detection
    (view.app.vault.read as jest.Mock).mockResolvedValue('{"days":{}}');

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    expect(modifyHandler).not.toBeNull();
    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    // Flush async vault.read and promise microtasks
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);

    expect(consumeSpy).toHaveBeenCalledWith('LOGS/2025-01-state.json', '{"days":{}}', expect.any(Number));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test('queues state file delete during write barrier and defers full reload', async () => {
    const { view } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');

    let deleteHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'delete') {
        deleteHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(deleteHandler).not.toBeNull();

    view.dayStateManager.beginWriteBarrier();

    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    deleteHandler?.(file);

    expect(clearSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();

    await view.dayStateManager.endWriteBarrier();
    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(reloadSpy).toHaveBeenCalledWith({
      runBoundaryCheck: false,
      clearDayStateCache: 'all',
    });
  });

  test('ignores state file delete under similarly prefixed sibling folder', async () => {
    const { view } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');

    let deleteHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'delete') {
        deleteHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(deleteHandler).not.toBeNull();

    const file = new TFile();
    file.path = 'LOGS-backup/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    deleteHandler?.(file);

    expect(clearSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test('ignores state file rename under similarly prefixed sibling folder', async () => {
    const { view } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');

    const renameHandlers: Array<(file: TFile, oldPath: string) => void> = [];
    (view.app.vault.on as jest.Mock).mockImplementation(
      (event: string, callback: (file: TFile, oldPath: string) => void) => {
        if (event === 'rename') {
          renameHandlers.push(callback);
        }
        return { detach: jest.fn() };
      },
    );

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(renameHandlers.length).toBeGreaterThan(0);

    const file = new TFile();
    file.path = 'LOGS-backup/2025-02-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    for (const handler of renameHandlers) {
      handler(file, 'LOGS-backup/2025-01-state.json');
    }

    expect(clearSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test('does not schedule external state processing after onClose when vault.read resolves late', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const consumeSpy = jest.fn(() => false);
    (plugin.dayStateService as unknown as {
      consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean
    }).consumeLocalStateWrite = consumeSpy;

    let resolveRead: ((content: string) => void) | null = null;
    (view.app.vault.read as jest.Mock).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(modifyHandler).not.toBeNull();

    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    await view.onClose();
    resolveRead?.('{"days":{}}');
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test('does not treat external change as local when local write happens during read delay', async () => {
    const { view, plugin } = createView();
    const scheduleSpy = jest
      .spyOn(
        view as unknown as {
          scheduleExternalStateChangeProcessing: (
            filePath: string,
            dayStateService: { consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean },
          ) => void
        },
        'scheduleExternalStateChangeProcessing',
      )
      .mockImplementation(() => undefined);

    let resolveRead: ((content: string) => void) | null = null;
    (view.app.vault.read as jest.Mock).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const consumeSpy = jest.fn(
      (_path: string, _content?: string, maxRecordedAt?: number) => maxRecordedAt === undefined,
    );
    (plugin.dayStateService as unknown as {
      consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean
    }).consumeLocalStateWrite = consumeSpy;

    let modifyHandler: ((file: TFile) => void) | null = null;
    (view.app.vault.on as jest.Mock).mockImplementation((event: string, callback: (file: TFile) => void) => {
      if (event === 'modify') {
        modifyHandler = callback;
      }
      return { detach: jest.fn() };
    });

    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();
    expect(modifyHandler).not.toBeNull();

    const file = new TFile();
    file.path = 'LOGS/2025-01-state.json';
    Object.setPrototypeOf(file, TFile.prototype);
    modifyHandler?.(file);

    resolveRead?.('{"local":"new"}');
    await Promise.resolve();
    await Promise.resolve();

    expect(consumeSpy).toHaveBeenCalledWith(
      'LOGS/2025-01-state.json',
      '{"local":"new"}',
      expect.any(Number),
    );
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      'LOGS/2025-01-state.json',
      expect.objectContaining({
        consumeLocalStateWrite: consumeSpy,
      }),
    );
  });
});

describe('TaskChuteView barrier pending external changes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('falls back to full reload when barrier queued reload has no resolved month key', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: [] }));

    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view as unknown as { pendingReloadAfterBarrier: boolean }).pendingReloadAfterBarrier = true;
    (view as unknown as { pendingExternalMergeMonthKeys: Set<string> }).pendingExternalMergeMonthKeys = new Set();

    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledWith({
      runBoundaryCheck: false,
      clearDayStateCache: 'all',
    });
  });

  test('prioritizes full reload when barrier queued full reload and month keys coexist', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: ['2025-01-01'] }));

    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view as unknown as { pendingReloadAfterBarrier: boolean }).pendingReloadAfterBarrier = true;
    (view as unknown as { pendingExternalMergeMonthKeys: Set<string> }).pendingExternalMergeMonthKeys = new Set(['2025-01']);
    (view as unknown as { pendingFullReloadAfterBarrier: boolean }).pendingFullReloadAfterBarrier = true;

    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledWith({
      runBoundaryCheck: false,
      clearDayStateCache: 'all',
    });
  });

  test('reloads after barrier merge even when affectedDateKeys is empty', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: [] }));

    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view as unknown as { pendingReloadAfterBarrier: boolean }).pendingReloadAfterBarrier = true;
    (view as unknown as { pendingExternalMergeMonthKeys: Set<string> }).pendingExternalMergeMonthKeys = new Set(['2025-01']);

    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(mergeSpy).toHaveBeenCalledWith('2025-01');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy.mock.calls[0]).toEqual([]);
    expect(reloadSpy).toHaveBeenCalledWith({
      runBoundaryCheck: false,
      clearDayStateCache: 'none',
    });
  });

  test('does not reload barrier pending changes when view is closing', async () => {
    const { view, plugin } = createView();
    const reloadSpy = jest
      .spyOn(view, 'reloadTasksAndRestore')
      .mockResolvedValue(undefined);
    const clearSpy = jest.spyOn(view.dayStateManager, 'clear');
    const mergeSpy = jest.fn(async () => ({ merged: {}, affectedDateKeys: ['2025-01-01'] }));

    (plugin.dayStateService as unknown as {
      mergeExternalChange?: (monthKey: string) => Promise<{ merged: unknown; affectedDateKeys: string[] }>;
    }).mergeExternalChange = mergeSpy;

    (view as unknown as { pendingReloadAfterBarrier: boolean }).pendingReloadAfterBarrier = true;
    (view as unknown as { pendingExternalMergeMonthKeys: Set<string> }).pendingExternalMergeMonthKeys = new Set(['2025-01']);
    (view as unknown as { isClosingOrClosed: boolean }).isClosingOrClosed = true;

    await (view as unknown as { processBarrierPendingExternalChanges: () => Promise<void> }).processBarrierPendingExternalChanges();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('TaskChuteView onClose cleanup', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('onClose disposes interactive scaffolding and timers', async () => {
    const { view } = createView();

    const closeMock = jest.fn();
    const scheduleAccessor = view.taskScheduleController as unknown as {
      activeMoveCalendar: MoveCalendarStub | null;
    };
    scheduleAccessor.activeMoveCalendar = {
      close: closeMock,
    } as MoveCalendarStub;

    const autocompleteCleanup = jest.fn();
    const secondaryCleanup = jest.fn();
    (view as Mutable<TaskChuteView>).autocompleteInstances = [
      { cleanup: autocompleteCleanup } as AutocompleteInstance,
      { cleanup: secondaryCleanup } as AutocompleteInstance,
    ];

    const disposeMock = jest.fn();
    (view as Mutable<TaskChuteView>).timerService = {
      dispose: disposeMock,
    } as unknown as TimerServiceStub;

    const fakeInterval = {} as ReturnType<typeof setInterval>;
    const fakeTimeout = {} as ReturnType<typeof setTimeout>;
    const fakeDebounce = {} as ReturnType<typeof setTimeout>;
    (view as Mutable<TaskChuteView>).globalTimerInterval = fakeInterval;
    (view as Mutable<TaskChuteView>).boundaryCheckTimeout = fakeTimeout;
    (view as Mutable<TaskChuteView>).renderDebounceTimer = fakeDebounce;

    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const containerRemoveSpy = jest.spyOn(view.containerEl, 'removeEventListener');

    const vaultDetach = jest.fn();
    (view.app.vault.on as jest.Mock).mockReturnValue({ detach: vaultDetach });
    (view as unknown as { setupEventListeners: () => void }).setupEventListeners();

    (view as unknown as { registerManagedDisposer: (cleanup: () => void) => void }).registerManagedDisposer(
      () => {
        closeMock();
        scheduleAccessor.activeMoveCalendar = null;
      },
    );

    try {
      await view.onClose();

      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(scheduleAccessor.activeMoveCalendar).toBeNull();

      expect(autocompleteCleanup).toHaveBeenCalledTimes(1);
      expect(secondaryCleanup).toHaveBeenCalledTimes(1);
      expect(view['autocompleteInstances']).toHaveLength(0);

      expect(disposeMock).toHaveBeenCalledTimes(1);
      expect(view['timerService']).toBeNull();

      expect(clearIntervalSpy).toHaveBeenCalledWith(fakeInterval);
      expect(view['globalTimerInterval']).toBeNull();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeTimeout);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeDebounce);
      expect(view['boundaryCheckTimeout']).toBeNull();
      expect(view['renderDebounceTimer']).toBeNull();
      expect(containerRemoveSpy).toHaveBeenCalled();
      expect(vaultDetach).toHaveBeenCalled();
    } finally {
      clearIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      containerRemoveSpy.mockRestore();
    }
  });
});

describe('TaskChuteView cross-day start handling', () => {
  test('persists existing running records alongside new routine instance', async () => {
    const { view } = createView();
    const existingRecord = {
      date: '2025-01-02',
      taskTitle: 'Existing Routine',
      taskPath: 'TASKS/existing.md',
      startTime: new Date('2025-01-02T08:00:00.000Z').toISOString(),
      slotKey: '8:00-12:00',
      instanceId: 'existing-inst',
      isRoutine: true,
    };

    const saveSpy = jest
      .spyOn(view.runningTasksService, 'save')
      .mockResolvedValue(undefined);
    jest
      .spyOn(view.runningTasksService, 'loadForDate')
      .mockResolvedValue([existingRecord]);

    (view as Mutable<TaskChuteView>)['reloadTasksAndRestore'] = jest
      .fn()
      .mockResolvedValue(undefined);
    const refreshSpy = jest
      .spyOn(view.taskHeaderController, 'refreshDateLabel')
      .mockImplementation(() => undefined);

    const routineTask = createTaskData({
      path: 'TASKS/new-routine.md',
      name: 'New Routine',
      isRoutine: true,
    });
    const instance = createTaskInstance(routineTask, {
      state: 'running',
      slotKey: '8:00-12:00',
      startTime: new Date('2025-01-02T10:00:00.000Z'),
      instanceId: 'new-inst',
    });

    await view.handleCrossDayStart({
      today: new Date(2025, 0, 2),
      todayKey: '2025-01-02',
      instance,
    });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [saved] = saveSpy.mock.calls[0];
    expect(saved).toHaveLength(2);
    const paths = saved.map((inst) => inst.task.path);
    expect(paths).toContain('TASKS/existing.md');
    expect(paths).toContain('TASKS/new-routine.md');
    expect(view.currentDate.getFullYear()).toBe(2025);
    expect(view.currentDate.getMonth()).toBe(0);
    expect(view.currentDate.getDate()).toBe(2);
    expect(refreshSpy).toHaveBeenCalled();
  });

  test('moves duplicate entry to today when starting from past date', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();

    const duplicateEntry = {
      instanceId: 'dup-1',
      originalPath: 'TASKS/weekly.md',
      slotKey: '8:00-12:00',
      originalSlotKey: '8:00-12:00',
      timestamp: 10,
      createdMillis: 10,
      originalTaskId: 'tc-weekly',
    };
    view.getCurrentDayState().duplicatedInstances.push(duplicateEntry);

    jest
      .spyOn(view.runningTasksService, 'loadForDate')
      .mockResolvedValue([]);
    jest
      .spyOn(view.runningTasksService, 'save')
      .mockResolvedValue(undefined);

    (view as Mutable<TaskChuteView>)['reloadTasksAndRestore'] = jest
      .fn()
      .mockResolvedValue(undefined);
    const refreshSpy = jest
      .spyOn(view.taskHeaderController, 'refreshDateLabel')
      .mockImplementation(() => undefined);
    const persistSpy = jest
      .spyOn(view as unknown as { persistDayState: (date: string) => Promise<void> }, 'persistDayState')
      .mockResolvedValue(undefined);

    const routineTask = createTaskData({
      path: 'TASKS/weekly.md',
      name: 'Weekly',
      isRoutine: true,
      taskId: 'tc-weekly',
    });
    const instance = createTaskInstance(routineTask, {
      state: 'running',
      slotKey: '16:00-0:00',
      originalSlotKey: '8:00-12:00',
      instanceId: 'dup-1',
    });

    await view.handleCrossDayStart({
      today: new Date(2025, 0, 2),
      todayKey: '2025-01-02',
      instance,
    });

    const prevState = view.dayStateManager.getStateFor('2025-01-01');
    expect(prevState.duplicatedInstances.some((entry) => entry.instanceId === 'dup-1')).toBe(false);
    const todayState = view.dayStateManager.getStateFor('2025-01-02');
    const movedEntry = todayState.duplicatedInstances.find((entry) => entry.instanceId === 'dup-1');
    expect(movedEntry).toMatchObject({
      instanceId: 'dup-1',
      originalPath: 'TASKS/weekly.md',
      slotKey: '16:00-0:00',
      originalSlotKey: '8:00-12:00',
      originalTaskId: 'tc-weekly',
    });
    expect(persistSpy).toHaveBeenCalledWith('2025-01-01');
    expect(persistSpy).toHaveBeenCalledWith('2025-01-02');
    expect(refreshSpy).toHaveBeenCalled();
  });

  test('clears permanent deletion for running task on today', async () => {
    const { view } = createView();
    await view.ensureDayStateForCurrentDate();
    await view.dayStateManager.ensure('2025-01-02');

    view.dayStateManager.setDeleted(
      [
        {
          path: 'TASKS/weekly.md',
          deletionType: 'permanent',
          timestamp: Date.now(),
          taskId: 'tc-weekly',
        },
      ],
      '2025-01-02',
    );

    jest
      .spyOn(view.runningTasksService, 'loadForDate')
      .mockResolvedValue([]);
    jest
      .spyOn(view.runningTasksService, 'save')
      .mockResolvedValue(undefined);

    (view as Mutable<TaskChuteView>)['reloadTasksAndRestore'] = jest
      .fn()
      .mockResolvedValue(undefined);
    jest
      .spyOn(view.taskHeaderController, 'refreshDateLabel')
      .mockImplementation(() => undefined);

    const routineTask = createTaskData({
      path: 'TASKS/weekly.md',
      name: 'Weekly',
      isRoutine: true,
      taskId: 'tc-weekly',
    });
    const instance = createTaskInstance(routineTask, {
      state: 'running',
      instanceId: 'dup-1',
    });

    await view.handleCrossDayStart({
      today: new Date(2025, 0, 2),
      todayKey: '2025-01-02',
      instance,
    });

    const deleted = view.dayStateManager.getDeleted('2025-01-02');
    const restoredEntry = deleted.find(
      (entry) =>
        entry.deletionType === 'permanent' &&
        (entry.path === 'TASKS/weekly.md' || entry.taskId === 'tc-weekly'),
    );
    expect(restoredEntry).toBeDefined();
    expect(restoredEntry?.restoredAt).toEqual(expect.any(Number));
    expect(
      view.dayStateManager.isDeleted({
        dateKey: '2025-01-02',
        taskId: 'tc-weekly',
        path: 'TASKS/weekly.md',
      }),
    ).toBe(false);
  });
});

describe('TaskChuteView restoreDeletedTask', () => {
  test('sets restoredAt on matching entry and reloads view', async () => {
    const { view } = createView()
    const task = createTaskData({ taskId: 'tc-task-restore', displayTitle: 'Restore me' })
    view.tasks = [task]

    const deletedEntry = { taskId: 'tc-task-restore', deletionType: 'permanent' as const }
    const setDeleted = jest.fn()
    const persist = jest.fn().mockResolvedValue(undefined)
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [deletedEntry])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      persist,
      getCurrent: jest.fn(() => createDayState()),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const restored = await view.restoreDeletedTask(deletedEntry, '2025-01-01')

    expect(restored).toBe(true)
    // Entry is NOT removed; instead restoredAt is set for sync propagation
    expect(setDeleted).toHaveBeenCalledWith(
      [expect.objectContaining({
        taskId: 'tc-task-restore',
        deletionType: 'permanent',
        restoredAt: expect.any(Number),
      })],
      '2025-01-01',
    )
    expect(persist).toHaveBeenCalledWith('2025-01-01')
    expect(view.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: false })
  })

  test('ensures restoredAt is after deletedAt even with clock skew', async () => {
    const { view } = createView()
    const deletedEntry = {
      taskId: 'tc-task-restore',
      deletionType: 'permanent' as const,
      deletedAt: 5000,
    }
    const setDeleted = jest.fn()
    const persist = jest.fn().mockResolvedValue(undefined)
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [deletedEntry])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      persist,
      getCurrent: jest.fn(() => createDayState()),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const restored = await view.restoreDeletedTask(deletedEntry, '2025-01-01')
      expect(restored).toBe(true)
      const [[updated]] = setDeleted.mock.calls
      const restoredAt = updated[0]?.restoredAt ?? 0
      expect(restoredAt).toBeGreaterThan(5000)
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('returns false when entry is missing', async () => {
    const { view } = createView()
    const setDeleted = jest.fn()
    const persist = jest.fn()
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [
      { taskId: 'tc-task-other', deletionType: 'permanent' },
    ])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      persist,
      getCurrent: jest.fn(() => createDayState()),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const restored = await view.restoreDeletedTask(
      { taskId: 'tc-task-missing', deletionType: 'permanent' },
      '2025-01-01',
    )

    expect(restored).toBe(false)
    expect(setDeleted).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(view.reloadTasksAndRestore).not.toHaveBeenCalled()
  })
})

describe('restoreDeletedTask - hiddenRoutines restoration', () => {
  test('restoring a deleted routine also restores path-level hiddenRoutines entry', async () => {
    const { view } = createView()
    const routinePath = 'ROUTINES/morning.md'
    const deletedEntry = {
      taskId: 'tc-routine-1',
      path: routinePath,
      deletionType: 'temporary' as const,
      deletedAt: 1000,
    }
    const hiddenEntry = {
      path: routinePath,
      instanceId: null,
      hiddenAt: 1000,
    }

    const setDeleted = jest.fn()
    const setHidden = jest.fn()
    const persist = jest.fn().mockResolvedValue(undefined)
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [deletedEntry])
    const getHidden = jest.fn(() => [hiddenEntry])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      getHidden,
      setHidden,
      persist,
      getCurrent: jest.fn(() => createDayState({
        deletedInstances: [deletedEntry],
        hiddenRoutines: [hiddenEntry],
      })),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const restored = await view.restoreDeletedTask(deletedEntry, '2025-01-01')

    expect(restored).toBe(true)
    // deletedInstances の restoredAt が設定される
    expect(setDeleted).toHaveBeenCalledWith(
      [expect.objectContaining({
        taskId: 'tc-routine-1',
        restoredAt: expect.any(Number),
      })],
      '2025-01-01',
    )
    // hiddenRoutines のパスレベルエントリも restoredAt が設定される
    expect(setHidden).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: routinePath,
        instanceId: null,
        restoredAt: expect.any(Number),
      })],
      '2025-01-01',
    )
    // restoredAt は hiddenAt より大きい
    const [[hiddenArgs]] = setHidden.mock.calls
    expect(hiddenArgs[0].restoredAt).toBeGreaterThan(1000)
  })

  test('does not modify hiddenRoutines when no path-level entry exists', async () => {
    const { view } = createView()
    const routinePath = 'ROUTINES/morning.md'
    const deletedEntry = {
      taskId: 'tc-routine-2',
      path: routinePath,
      deletionType: 'temporary' as const,
      deletedAt: 1000,
    }

    const setDeleted = jest.fn()
    const setHidden = jest.fn()
    const persist = jest.fn().mockResolvedValue(undefined)
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [deletedEntry])
    // パスレベルエントリがない（instanceId付きのみ）
    const getHidden = jest.fn(() => [
      { path: routinePath, instanceId: 'some-instance', hiddenAt: 1000 },
    ])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      getHidden,
      setHidden,
      persist,
      getCurrent: jest.fn(() => createDayState()),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const restored = await view.restoreDeletedTask(deletedEntry, '2025-01-01')

    expect(restored).toBe(true)
    expect(setDeleted).toHaveBeenCalled()
    // hiddenRoutines にパスレベルエントリがないので setHidden は呼ばれない
    expect(setHidden).not.toHaveBeenCalled()
  })

  test('does not modify hiddenRoutines when entry has no path', async () => {
    const { view } = createView()
    const deletedEntry = {
      taskId: 'tc-no-path',
      deletionType: 'permanent' as const,
    }

    const setDeleted = jest.fn()
    const setHidden = jest.fn()
    const persist = jest.fn().mockResolvedValue(undefined)
    const ensure = jest.fn().mockResolvedValue(createDayState())
    const getDeleted = jest.fn(() => [deletedEntry])
    const getHidden = jest.fn(() => [])

    view.reloadTasksAndRestore = jest.fn().mockResolvedValue(undefined)
    ;(view as Mutable<TaskChuteView>).dayStateManager = {
      ensure,
      getDeleted,
      setDeleted,
      getHidden,
      setHidden,
      persist,
      getCurrent: jest.fn(() => createDayState()),
      getCurrentKey: jest.fn(() => '2025-01-01'),
      snapshot: jest.fn(),
    } as unknown as DayStateStoreService

    const restored = await view.restoreDeletedTask(deletedEntry, '2025-01-01')

    expect(restored).toBe(true)
    expect(setDeleted).toHaveBeenCalled()
    // path がないので getHidden/setHidden は呼ばれない
    expect(getHidden).not.toHaveBeenCalled()
    expect(setHidden).not.toHaveBeenCalled()
  })
})
