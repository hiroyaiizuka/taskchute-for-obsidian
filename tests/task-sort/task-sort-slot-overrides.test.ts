import { TaskChuteView } from '../../src/views/TaskChuteView';
import type { DayState, TaskData, TaskInstance } from '../../src/types';
import { createRoutineLoadContext } from '../utils/taskViewTestUtils';

const persistSlotAssignment = TaskChuteView.prototype.persistSlotAssignment as unknown as (
  this: TaskChuteView,
  inst: TaskInstance,
) => void;

const getTaskSlotKey = TaskChuteView.prototype.getTaskSlotKey as unknown as (
  this: TaskChuteView,
  task: TaskData,
) => string;

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

interface ViewStub {
  plugin: PluginStub;
  getCurrentDayState: jest.Mock<DayState>;
  getOrderKey: jest.Mock<string | null>;
}

function createViewStub(
  dayState: DayState,
  pluginOverrides: Partial<PluginStub> = {},
): { view: ViewStub; plugin: PluginStub } {
  const baseSettings = pluginOverrides.settings ?? { slotKeys: {} as Record<string, string> };
  if (!baseSettings.slotKeys) {
    baseSettings.slotKeys = {};
  }

  const plugin: PluginStub = {
    settings: baseSettings,
    saveSettings: pluginOverrides.saveSettings ?? jest.fn().mockResolvedValue(undefined),
  };

  const view: ViewStub = {
    plugin,
    getCurrentDayState: jest.fn(() => dayState),
    getOrderKey: jest.fn(() => null),
  };

  return { view, plugin };
}

describe('Task sort slot overrides', () => {
  describe('persistSlotAssignment', () => {
    test('stores routine slot overrides in day state only', () => {
      const dayState = createDayState();
      const { view, plugin } = createViewStub(dayState);

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

      persistSlotAssignment.call(view as unknown as TaskChuteView, inst);

      expect(dayState.slotOverrides['Tasks/routine.md']).toBe('16:00-0:00');
      expect(plugin.settings.slotKeys).toEqual({});
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    test('removes routine override when slot matches scheduled default', () => {
      const dayState = createDayState({
        slotOverrides: { 'Tasks/routine.md': '16:00-0:00' },
      });
      const { view } = createViewStub(dayState);

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

      persistSlotAssignment.call(view as unknown as TaskChuteView, inst);

      expect(dayState.slotOverrides['Tasks/routine.md']).toBeUndefined();
    });

    test('stores non-routine overrides in plugin settings', () => {
      const dayState = createDayState();
      const pluginOverrides = {
        settings: { slotKeys: {} as Record<string, string> },
      };
      const { view, plugin } = createViewStub(dayState, pluginOverrides);

      const inst: TaskInstance = {
        task: {
          path: 'Tasks/one-off.md',
          isRoutine: false,
        } as TaskData,
        slotKey: '12:00-16:00',
        instanceId: 'non-routine-1',
        state: 'idle',
      };

      persistSlotAssignment.call(view as unknown as TaskChuteView, inst);

      expect(plugin.settings.slotKeys['Tasks/one-off.md']).toBe('12:00-16:00');
      expect(plugin.saveSettings).toHaveBeenCalled();
    });
  });

  describe('getTaskSlotKey', () => {
    test('uses day-state override for routines when present', () => {
      const dayState = createDayState({
        slotOverrides: { 'Tasks/routine.md': '16:00-0:00' },
      });
      const { view } = createViewStub(dayState);

      const result = getTaskSlotKey.call(view as unknown as TaskChuteView, {
        path: 'Tasks/routine.md',
        isRoutine: true,
        scheduledTime: '08:00',
      } as TaskData);

      expect(result).toBe('16:00-0:00');
    });

    test('falls back to scheduled time for routines without overrides', () => {
      const dayState = createDayState();
      const { view } = createViewStub(dayState);

      const result = getTaskSlotKey.call(view as unknown as TaskChuteView, {
        path: 'Tasks/routine.md',
        isRoutine: true,
        scheduledTime: '08:00',
      } as TaskData);

      expect(result).toBe('8:00-12:00');
    });

    test('uses plugin slotKeys for non-routine tasks', () => {
      const dayState = createDayState();
      const pluginOverrides = {
        settings: { slotKeys: { 'Tasks/one-off.md': '12:00-16:00' } },
      };
      const { view } = createViewStub(dayState, pluginOverrides);

      const result = getTaskSlotKey.call(view as unknown as TaskChuteView, {
        path: 'Tasks/one-off.md',
        isRoutine: false,
      } as TaskData);

      expect(result).toBe('12:00-16:00');
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
