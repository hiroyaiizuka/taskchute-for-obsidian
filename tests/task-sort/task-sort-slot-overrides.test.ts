import TaskMutationService, { TaskMutationHost } from '../../src/features/core/services/TaskMutationService';
import type { DayState, TaskData, TaskInstance, DeletedInstance } from '../../src/types';
import type DayStateStoreService from '../../src/services/DayStateStoreService';
import { createRoutineLoadContext } from '../utils/taskViewTestUtils';

function createDayState(partial?: Partial<DayState>): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
    ...partial,
  };
}

interface PluginStub {
  settings: { slotKeys: Record<string, string> };
  saveSettings: jest.Mock<Promise<void>, []>;
}

function createMutationHost(dayState: DayState, pluginOverrides: Partial<PluginStub> = {}) {
  const plugin: PluginStub = {
    settings: pluginOverrides.settings ?? { slotKeys: {} },
    saveSettings: pluginOverrides.saveSettings ?? jest.fn().mockResolvedValue(undefined),
  }

  const dayStateManager = {
    getDeleted: jest.fn(() => dayState.deletedInstances),
    setDeleted: jest.fn((entries: DeletedInstance[]) => {
      dayState.deletedInstances = entries
    }),
  } as unknown as DayStateStoreService

  const host: TaskMutationHost = {
    tv: (_key: string, fallback: string) => fallback,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(async () => '{}'),
        modify: jest.fn(async () => {}),
        create: jest.fn(async () => {}),
      },
      fileManager: {
        trashFile: jest.fn(async () => {}),
      },
    },
    plugin,
    taskInstances: [] as TaskInstance[],
    tasks: [] as TaskData[],
    renderTaskList: jest.fn(),
    generateInstanceId: () => 'generated-id',
    getInstanceDisplayTitle: () => 'Task',
    ensureDayStateForCurrentDate: jest.fn(async () => {}),
    getCurrentDayState: () => dayState,
    persistDayState: jest.fn(async () => {}),
    getCurrentDateString: () => '2025-10-09',
    calculateSimpleOrder: () => 0,
    normalizeState: () => 'idle',
    saveTaskOrders: jest.fn(async () => {}),
    sortTaskInstancesByTimeOrder: jest.fn(),
    getOrderKey: () => null,
    dayStateManager,
  }

  return { host, plugin }
}

describe('Task sort slot overrides', () => {
  describe('persistSlotAssignment', () => {
    test('stores routine slot overrides in day state only', () => {
      const dayState = createDayState();
      const inst: TaskInstance = {
        task: {
          path: 'Tasks/routine.md',
          isRoutine: true,
          scheduledTime: '08:00',
        } as TaskData,
        slotKey: '16:00-0:00',
        instanceId: 'routine-1',
        state: 'idle',
      };
      const { host, plugin } = createMutationHost(dayState);
      const service = new TaskMutationService(host);

      service.persistSlotAssignment(inst);

      expect(dayState.slotOverrides['Tasks/routine.md']).toBe('16:00-0:00');
      expect(plugin.settings.slotKeys).toEqual({});
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    test('removes routine override when slot matches scheduled default', () => {
      const dayState = createDayState({
        slotOverrides: { 'Tasks/routine.md': '16:00-0:00' },
      });
      const inst: TaskInstance = {
        task: {
          path: 'Tasks/routine.md',
          isRoutine: true,
          scheduledTime: '08:00',
        } as TaskData,
        slotKey: '8:00-12:00',
        instanceId: 'routine-1',
        state: 'idle',
      };
      const { host } = createMutationHost(dayState);
      const service = new TaskMutationService(host);

      service.persistSlotAssignment(inst);

      expect(dayState.slotOverrides['Tasks/routine.md']).toBeUndefined();
    });

    test('stores non-routine overrides in plugin settings', () => {
      const dayState = createDayState();
      const pluginOverrides = { settings: { slotKeys: {} as Record<string, string> } };

      const inst: TaskInstance = {
        task: {
          path: 'Tasks/one-off.md',
          isRoutine: false,
        } as TaskData,
        slotKey: '12:00-16:00',
        instanceId: 'non-routine-1',
        state: 'idle',
      };
      const { host, plugin } = createMutationHost(dayState, pluginOverrides);
      const service = new TaskMutationService(host);

      service.persistSlotAssignment(inst);

      expect(plugin.settings.slotKeys['Tasks/one-off.md']).toBe('12:00-16:00');
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe('loadTasksRefactored integration', () => {
    test('respects per-day overrides when generating routine instances', async () => {
      const { context, routinePath, load } = createRoutineLoadContext({ slotOverride: '16:00-0:00' });

      await load();

      expect(context.taskInstances).toHaveLength(1);
      expect(context.taskInstances[0].slotKey).toBe('16:00-0:00');
      expect(context.tasks[0].path).toBe(routinePath);
    });

    test('falls back to scheduled time when override is absent', async () => {
      const { context, load } = createRoutineLoadContext();

      await load();

      expect(context.taskInstances).toHaveLength(1);
      expect(context.taskInstances[0].slotKey).toBe('8:00-12:00');
    });
  });
});
