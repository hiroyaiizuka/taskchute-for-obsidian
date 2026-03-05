import TaskReloadCoordinator, {
  TaskReloadCoordinatorHost,
} from '../../src/features/core/services/TaskReloadCoordinator';
import type { TaskInstance } from '../../src/types';
import { SectionConfigService } from '../../src/services/SectionConfigService';

jest.mock('../../src/utils/time', () => {
  const actual = jest.requireActual('../../src/utils/time');
  return {
    ...actual,
    calculateNextBoundary: jest.fn(() => new Date('2025-10-10T00:00:00.000Z')),
    getCurrentTimeSlot: jest.fn(() => '8:00-12:00'),
  };
});

const { calculateNextBoundary } = jest.requireMock('../../src/utils/time');

interface ViewStub extends TaskReloadCoordinatorHost {
  getCurrentDateString: () => string;
}

function createViewStub(): ViewStub {
  const sectionConfig = new SectionConfigService()
  const stub: ViewStub = {
    loadTasks: jest.fn().mockResolvedValue(undefined),
    restoreRunningTaskState: jest.fn().mockResolvedValue(undefined),
    renderTaskList: jest.fn(),
    persistSlotAssignment: jest.fn(),
    sortTaskInstancesByTimeOrder: jest.fn(),
    saveTaskOrders: jest.fn().mockResolvedValue(undefined),
    taskInstances: [],
    boundaryCheckTimeout: null,
    currentDate: new Date('2025-10-09T00:00:00.000Z'),
    getCurrentDateString: () => '2025-10-09',
    getTimeSlotKeys: () => ['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00'],
    getSectionConfig: () => sectionConfig,
  }
  return stub
}

describe('TaskReloadCoordinator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Set time to 9:00 AM in local time (not UTC)
    jest.setSystemTime(new Date(2025, 9, 9, 9, 0, 0, 0));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.setSystemTime(new Date());
    jest.useRealTimers();
  });

  test('reloadTasksAndRestore executes load/restore/render and schedules boundary when requested', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    const checkSpy = jest
      .spyOn(coordinator, 'checkBoundaryTasks')
      .mockResolvedValue(undefined);
    const scheduleSpy = jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    await coordinator.reloadTasksAndRestore({ runBoundaryCheck: true });

    expect(view.loadTasks).toHaveBeenCalledTimes(1);
    expect(view.restoreRunningTaskState).toHaveBeenCalledTimes(1);
    expect(view.renderTaskList).toHaveBeenCalledTimes(1);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    checkSpy.mockRestore();
    scheduleSpy.mockRestore();
  });

  test('scheduleBoundaryCheck clears prior timeout and registers new timer', () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);

    const timeout = setTimeout(() => undefined, 0);
    view.boundaryCheckTimeout = timeout;

    coordinator.scheduleBoundaryCheck();

    expect(calculateNextBoundary).toHaveBeenCalledTimes(1);
    expect(view.boundaryCheckTimeout).not.toBe(timeout);
  });

  test('concurrent reloadTasksAndRestore calls are serialized (second waits for first)', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    let resolveFirst!: () => void;
    (view.loadTasks as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );

    const first = coordinator.reloadTasksAndRestore();
    const second = coordinator.reloadTasksAndRestore({ runBoundaryCheck: true });

    // loadTasks called only once so far (first is in-flight)
    expect(view.loadTasks).toHaveBeenCalledTimes(1);

    // Resolve the first load
    resolveFirst();
    await first;
    await second;

    // After both settle, loadTasks should have been called twice:
    // once for the first call, once for the pending second
    expect(view.loadTasks).toHaveBeenCalledTimes(2);
  });

  test('mergeReloadOptions picks the higher-priority clearDayStateCache', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    let resolveFirst!: () => void;
    (view.loadTasks as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );

    const first = coordinator.reloadTasksAndRestore({ clearDayStateCache: 'current' });
    // Queue two more — 'all' should win over 'current'
    const second = coordinator.reloadTasksAndRestore({ clearDayStateCache: 'current' });
    const third = coordinator.reloadTasksAndRestore({ clearDayStateCache: 'all' });

    resolveFirst();
    await Promise.all([first, second, third]);

    // The merged pending call should use 'all'
    const calls = (view.loadTasks as jest.Mock).mock.calls;
    expect(calls[calls.length - 1][0]).toEqual({ clearDayStateCache: 'all' });
  });

  test('mergeReloadOptions keeps current cache-clear behavior when options are omitted', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    let resolveFirst!: () => void;
    (view.loadTasks as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );

    const first = coordinator.reloadTasksAndRestore();
    const second = coordinator.reloadTasksAndRestore();
    const third = coordinator.reloadTasksAndRestore();

    resolveFirst();
    await Promise.all([first, second, third]);

    const calls = (view.loadTasks as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[calls.length - 1][0]).toEqual({ clearDayStateCache: 'current' });
  });

  test('error in reload clears pendingOptions and rejects all awaiters', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    const loadError = new Error('load failed');
    (view.loadTasks as jest.Mock).mockRejectedValueOnce(loadError);

    const first = coordinator.reloadTasksAndRestore();
    const second = coordinator.reloadTasksAndRestore();

    await expect(first).rejects.toThrow('load failed');
    // second should resolve (it awaited the same promise, which rejected,
    // but the second caller just awaits reloadPromise and returns)
    // Actually: second awaits reloadPromise which rejects, so it should also reject
    // But in our implementation, the second caller just awaits the shared promise
    // and returns — it doesn't re-throw.  Let's verify:
    // Actually looking at the code: if (this.reloadPromise) { ... await this.reloadPromise; return }
    // So the second call awaits the same promise. If that rejects, the await will throw.
    await expect(second).rejects.toThrow('load failed');

    // After error, coordinator should accept new calls
    (view.loadTasks as jest.Mock).mockResolvedValue(undefined);
    await coordinator.reloadTasksAndRestore();
    // This should succeed without throwing
    expect(view.loadTasks).toHaveBeenCalledTimes(2); // 1 failed + 1 succeeded
  });

  test('re-entrant reload can enqueue when caller does not await while in-flight', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    let invocation = 0;
    (view.loadTasks as jest.Mock).mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) {
        void coordinator.reloadTasksAndRestore({
          runBoundaryCheck: false,
          clearDayStateCache: 'all',
          queueIfInProgress: true,
        });
      }
    });

    const completion = coordinator.reloadTasksAndRestore({
      runBoundaryCheck: false,
      clearDayStateCache: 'current',
    });
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(settled).toBe(true);
    await completion;
    expect((view.loadTasks as jest.Mock).mock.calls).toEqual([
      [{ clearDayStateCache: 'current' }],
      [{ clearDayStateCache: 'all' }],
    ]);
  });

  test('queued re-entrant caller is notified when the in-flight reload fails', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);
    jest.spyOn(coordinator, 'scheduleBoundaryCheck').mockImplementation(() => {});

    const loadError = new Error('load failed');
    let queuedPromise: Promise<void> | null = null;
    let invocation = 0;

    (view.loadTasks as jest.Mock).mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) {
        queuedPromise = coordinator.reloadTasksAndRestore({
          runBoundaryCheck: false,
          clearDayStateCache: 'all',
          queueIfInProgress: true,
        });
        throw loadError;
      }
    });

    await expect(
      coordinator.reloadTasksAndRestore({
        runBoundaryCheck: false,
        clearDayStateCache: 'current',
      }),
    ).rejects.toThrow('load failed');

    expect(queuedPromise).not.toBeNull();
    await expect(queuedPromise as Promise<void>).rejects.toThrow('load failed');
  });

  test('checkBoundaryTasks moves idle tasks from older slots into current slot', async () => {
    const view = createViewStub();
    const coordinator = new TaskReloadCoordinator(view);

    view.taskInstances = [
      {
        task: {
          path: 'TASKS/sample.md',
          isRoutine: false,
        },
        instanceId: 'idle-1',
        state: 'idle',
        slotKey: '0:00-8:00',
        date: '2025-10-09',
      } as TaskInstance,
    ];

    await coordinator.checkBoundaryTasks();

    expect(view.taskInstances[0].slotKey).toBe('8:00-12:00');
    expect(view.persistSlotAssignment).toHaveBeenCalledTimes(1);
    expect(view.sortTaskInstancesByTimeOrder).toHaveBeenCalledTimes(1);
    expect(view.saveTaskOrders).toHaveBeenCalledTimes(1);
    expect(view.renderTaskList).toHaveBeenCalledTimes(1);
  });
});
