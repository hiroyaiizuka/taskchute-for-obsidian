import TaskOrderManager, { TaskOrderManagerOptions } from '../../src/features/core/services/TaskOrderManager';
import DayStateStoreService from '../../src/services/DayStateStoreService';
import { DayState, TaskInstance } from '../../src/types';

describe('TaskOrderManager', () => {
  const createOptions = (overrides: Partial<TaskOrderManagerOptions> = {}) => {
    const dayState: DayState = {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    };

    const dayStateManager = {
      getStateFor: jest.fn(() => dayState),
    } as unknown as DayStateStoreService;

    const baseOptions: TaskOrderManagerOptions = {
      dayStateManager,
      getCurrentDateString: () => '2025-10-09',
      ensureDayStateForCurrentDate: jest.fn(async () => dayState),
      getCurrentDayState: () => dayState,
      persistDayState: jest.fn(async () => undefined),
      getTimeSlotKeys: () => ['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00'],
      getOrderKey: (inst) => {
        if (inst.task?.path) {
          return `${inst.task.path}::${inst.slotKey ?? 'none'}`;
        }
        return inst.instanceId ? `${inst.instanceId}::${inst.slotKey ?? 'none'}` : null;
      },
      useOrderBasedSort: () => true,
      normalizeState: (state) => {
        if (state === 'done') return 'done';
        if (state === 'running' || state === 'paused') return 'running';
        return 'idle';
      },
      getStatePriority: (state) => {
        if (state === 'done') return 0;
        if (state === 'running' || state === 'paused') return 1;
        return 2;
      },
    };

    return { options: { ...baseOptions, ...overrides }, dayState, dayStateManager };
  };

  const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    task: {
      path: overrides.task?.path ?? 'TASKS/sample.md',
      displayTitle: overrides.task?.displayTitle ?? 'Sample',
      isRoutine: overrides.task?.isRoutine ?? false,
      scheduledTime: overrides.task?.scheduledTime,
      createdMillis: overrides.task?.createdMillis ?? overrides.createdMillis,
    },
    instanceId: overrides.instanceId ?? `inst-${Math.random().toString(36).slice(2, 8)}`,
    state: overrides.state ?? 'idle',
    slotKey: overrides.slotKey ?? 'none',
    date: overrides.date ?? '2025-10-09',
    order: overrides.order,
    startTime: overrides.startTime,
    stopTime: overrides.stopTime,
    createdMillis: overrides.createdMillis ?? overrides.task?.createdMillis,
  });

  test('sortTaskInstancesByTimeOrder assigns deterministic orders for done/running/idle', () => {
    const { options, dayStateManager } = createOptions();
    const manager = new TaskOrderManager(options);
    const doneInst = createInstance({
      state: 'done',
      slotKey: '0:00-8:00',
      startTime: new Date('2025-10-09T02:00:00Z'),
    });
    const runningInst = createInstance({
      state: 'running',
      slotKey: '8:00-12:00',
      order: null,
      startTime: new Date('2025-10-09T09:00:00Z'),
    });
    const idleInst = createInstance({
      state: 'idle',
      slotKey: '12:00-16:00',
      task: {
        path: 'TASKS/idle.md',
        displayTitle: 'Idle',
        isRoutine: false,
        scheduledTime: '13:30',
      },
    });

    const instances = [idleInst, runningInst, doneInst];
    manager.sortTaskInstancesByTimeOrder(instances);

    expect(dayStateManager.getStateFor).toHaveBeenCalledWith('2025-10-09');
    expect(doneInst.order).toBe(100);
    expect(runningInst.order).toBe(100);
    expect(idleInst.order).toBe(100);
  });

  test('saveTaskOrders persists orders and duplicated instance slot data', async () => {
    const { options, dayState } = createOptions();
    dayState.duplicatedInstances = [
      {
        instanceId: 'dup-1',
        originalPath: 'TASKS/r.md',
      },
    ];

    const manager = new TaskOrderManager(options);
    const dupInstance = createInstance({
      instanceId: 'dup-1',
      slotKey: '8:00-12:00',
      order: 120,
      task: {
        path: 'TASKS/r.md',
        displayTitle: 'Routine Copy',
        isRoutine: false,
      },
    });
    const otherInstance = createInstance({
      instanceId: 'solo',
      slotKey: 'none',
      order: 220,
      task: {
        path: 'TASKS/solo.md',
        displayTitle: 'Solo',
        isRoutine: false,
      },
    });

    await manager.saveTaskOrders([dupInstance, otherInstance]);

    expect(dayState.orders).toEqual({
      'TASKS/r.md::8:00-12:00': 120,
      'TASKS/solo.md::none': 220,
    });
    expect(dayState.duplicatedInstances?.[0]?.slotKey).toBe('8:00-12:00');
    expect(options.persistDayState).toHaveBeenCalledWith('2025-10-09');
  });

  test('saveTaskOrders adds ordersMeta for keys without metadata', async () => {
    const { options, dayState } = createOptions();
    dayState.orders = {
      'TASKS/sample.md::none': 150,
    };
    const manager = new TaskOrderManager(options);
    const instance = createInstance({ order: 150 });

    await manager.saveTaskOrders([instance]);

    const meta = dayState.ordersMeta?.['TASKS/sample.md::none'];
    expect(meta?.order).toBe(150);
    expect(typeof meta?.updatedAt).toBe('number');
    expect(Number.isFinite(meta?.updatedAt)).toBe(true);
  });

  test('saveTaskOrders updates ordersMeta when order value changes', async () => {
    const { options, dayState } = createOptions();
    dayState.orders = {
      'TASKS/sample.md::none': 150,
    };
    dayState.ordersMeta = {
      'TASKS/sample.md::none': { order: 150, updatedAt: 1000 },
    };
    const manager = new TaskOrderManager(options);
    const instance = createInstance({ order: 250 });

    await manager.saveTaskOrders([instance]);

    const meta = dayState.ordersMeta?.['TASKS/sample.md::none'];
    expect(meta?.order).toBe(250);
    expect((meta?.updatedAt ?? 0)).toBeGreaterThan(1000);
  });

  test('saveTaskOrders rejects when persistDayState fails', async () => {
    const { options, dayState } = createOptions();
    const error = new Error('persist failed');
    options.persistDayState = jest.fn(async () => {
      throw error;
    });
    const manager = new TaskOrderManager(options);
    const instance = createInstance({ order: 150 });

    await expect(manager.saveTaskOrders([instance])).rejects.toThrow('persist failed');

    expect(dayState.orders).toEqual({
      'TASKS/sample.md::none': 150,
    });
  });

  test('loadSavedOrders normalizes legacy order objects and persists updates', async () => {
    const { options, dayState } = createOptions();
    dayState.orders = {
      'TASKS/legacy.md': { order: 420, slot: '8:00-12:00' },
      'TASKS/bad.md': { foo: 'bar' },
      'TASKS/valid.md::none': 230,
    } as unknown as Record<string, number>;
    const persistSpy = jest
      .spyOn(options, 'persistDayState')
      .mockResolvedValue(undefined);
    const manager = new TaskOrderManager(options);

    const normalized = manager.loadSavedOrders();

    expect(normalized).toEqual({
      'TASKS/legacy.md::8:00-12:00': 420,
      'TASKS/valid.md::none': 230,
    });
    expect(dayState.orders).toEqual(normalized);
    await Promise.resolve();
    expect(persistSpy).toHaveBeenCalledWith('2025-10-09');
  });

  test('ensureOrdersAcrossSlots handles save failures via error handler', async () => {
    const failure = new Error('save failed');
    const handleOrderSaveError = jest.fn();
    const { options } = createOptions({ handleOrderSaveError });
    options.persistDayState = jest.fn().mockRejectedValueOnce(failure);
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const manager = new TaskOrderManager(options);
    const instance = createInstance({ order: null, slotKey: 'none' });

    manager.ensureOrdersAcrossSlots([instance], { persist: true });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options.persistDayState).toHaveBeenCalledWith('2025-10-09');
    expect(errorSpy).toHaveBeenCalled();
    expect(handleOrderSaveError).toHaveBeenCalledWith(failure);
    errorSpy.mockRestore();
  });

  test('sortTaskInstancesByTimeOrder stacks unscheduled idle tasks by creation time', () => {
    const { options } = createOptions();
    const manager = new TaskOrderManager(options);
    const older = createInstance({
      task: {
        path: 'TASKS/older.md',
        displayTitle: 'Older',
        isRoutine: false,
        scheduledTime: undefined,
        createdMillis: 1_695_000_000_000,
      },
      createdMillis: 1_695_000_000_000,
      slotKey: 'none',
      order: undefined,
    });
    const newer = createInstance({
      task: {
        path: 'TASKS/newer.md',
        displayTitle: 'Newer',
        isRoutine: false,
        scheduledTime: undefined,
        createdMillis: 1_696_000_000_000,
      },
      createdMillis: 1_696_000_000_000,
      slotKey: 'none',
      order: undefined,
    });

    const instances = [older, newer];
    manager.sortTaskInstancesByTimeOrder(instances);
    const sorted = manager.sortByOrder(instances);

    expect(older.order).toBeGreaterThan(newer.order as number);
    expect(sorted[0]).toBe(newer);
    expect(sorted[1]).toBe(older);
  });

  test('calculateSimpleOrder returns midpoint when inserting between neighbors', () => {
    const { options } = createOptions();
    const manager = new TaskOrderManager(options);
    const neighborA = createInstance({ order: 100 });
    const neighborB = createInstance({ order: 300 });

    const result = manager.calculateSimpleOrder(1, [neighborA, neighborB]);

    expect(result).toBe(200);
  });

  test('calculateSimpleOrder normalizes orders when spacing is too narrow', () => {
    const { options } = createOptions();
    const manager = new TaskOrderManager(options);
    const neighborA = createInstance({ order: 100, task: { path: 'TASKS/a.md', displayTitle: 'A', isRoutine: false } });
    const neighborB = createInstance({ order: 101, task: { path: 'TASKS/b.md', displayTitle: 'B', isRoutine: false } });

    const result = manager.calculateSimpleOrder(1, [neighborA, neighborB]);

    expect(result).toBeGreaterThan(100);
    expect(result).toBeLessThan(300);
    expect(Number.isFinite(neighborA.order)).toBe(true);
    expect(Number.isFinite(neighborB.order)).toBe(true);
    expect(Math.abs((neighborB.order as number) - (neighborA.order as number))).toBeGreaterThan(1);
  });

  test('sortByOrder prioritizes state and order before schedule time', () => {
    const { options } = createOptions();
    const manager = new TaskOrderManager(options);
    const doneInst = createInstance({ state: 'done', order: 100, startTime: new Date('2025-10-09T07:00:00Z') });
    const runningInst = createInstance({ state: 'running', order: 200 });
    const idleInstEarly = createInstance({
      state: 'idle',
      task: { path: 'TASKS/idle1.md', displayTitle: 'Idle One', isRoutine: false, scheduledTime: '09:00' },
    });
    const idleInstLate = createInstance({
      state: 'idle',
      task: { path: 'TASKS/idle2.md', displayTitle: 'Idle Two', isRoutine: false, scheduledTime: '14:00' },
    });

    const sorted = manager.sortByOrder([idleInstLate, runningInst, idleInstEarly, doneInst]);

    expect(sorted[0]).toBe(doneInst);
    expect(sorted[1]).toBe(runningInst);
    expect(sorted[2]).toBe(idleInstEarly);
    expect(sorted[3]).toBe(idleInstLate);
  });
});
