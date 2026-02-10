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
