import DayStateStoreService from '../../src/services/DayStateStoreService';
import { DayState } from '../../src/types';

describe('DayStateStoreService', () => {
  function createState(overrides: Partial<DayState> = {}): DayState {
    return {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
      ...overrides,
    } as DayState;
  }

  function createDeps(initialStates: Record<string, DayState> = {}) {
    const cache = new Map<string, DayState>();
    const loadDay = jest.fn(async (date: Date) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return initialStates[key] ? createState(initialStates[key]) : createState();
    });
    const saveDay = jest.fn(async () => undefined);
    const updateDay = jest.fn(async (
      date: Date,
      mutator: (state: DayState) => DayState | void,
    ) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const working = createState(initialStates[key]);
      const result = mutator(working) ?? working;
      initialStates[key] = createState(result);
      return createState(result);
    });
    const deps = {
      dayStateService: {
        loadDay,
        saveDay,
        updateDay,
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
        clearCacheForDate: jest.fn(),
        getDateFromKey: jest.fn(),
        renameTaskPath: jest.fn().mockResolvedValue(undefined),
      },
      getCurrentDateString: () => '2025-10-09',
      parseDateString: (key: string) => {
        const [y, m, d] = key.split('-').map((v) => parseInt(v, 10));
        return new Date(y, (m || 1) - 1, d || 1);
      },
      cache,
    } as const;

    return { deps, loadDay, saveDay, updateDay, cache };
  }

  test('ensure loads missing day state and caches result', async () => {
    const preset = createState({ hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }] });
    const { deps, loadDay } = createDeps({ '2025-10-09': preset });
    const manager = new DayStateStoreService(deps);

    const state = await manager.ensure();

    expect(loadDay).toHaveBeenCalledTimes(1);
    expect(state.hiddenRoutines).toHaveLength(1);
    expect(manager.snapshot('2025-10-09')).toEqual(state);
  });

  test('mutateSnapshot updates another day without changing the shared current date', async () => {
    const other = createState({
      hiddenRoutines: [{ path: 'TASKS/other.md', instanceId: null }],
    });
    const { deps } = createDeps({ '2025-10-10': other });
    const manager = new DayStateStoreService(deps);
    await manager.ensure('2025-10-09');

    const snapshot = await manager.mutateSnapshot('2025-10-10', (state) => {
      state.duplicatedInstances.push({
        instanceId: 'dup-1',
        originalPath: 'TASKS/ai.md',
      });
    });

    expect(snapshot.hiddenRoutines).toHaveLength(1);
    expect(snapshot.duplicatedInstances).toHaveLength(1);
    expect(manager.snapshot('2025-10-10')).toBe(snapshot);
    expect(manager.getCurrentKey()).toBe('2025-10-09');
    expect(manager.getCurrent()).toBe(manager.snapshot('2025-10-09'));
  });

  test('mutateSnapshot serializes concurrent updates for different dates in the same month', async () => {
    const { deps } = createDeps({
      '2025-10-10': createState(),
      '2025-10-11': createState(),
    });
    const baseUpdateDay = deps.dayStateService.updateDay;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const updateDay = jest.fn(async (
      date: Date,
      mutator: (state: DayState) => DayState | void,
    ) => {
      callCount += 1;
      if (callCount === 1) await firstGate;
      return await baseUpdateDay(date, mutator);
    });
    deps.dayStateService.updateDay = updateDay;
    const manager = new DayStateStoreService(deps);

    const first = manager.mutateSnapshot('2025-10-10', (state) => {
      state.duplicatedInstances.push({
        instanceId: 'dup-1',
        originalPath: 'TASKS/first.md',
      });
    });
    const second = manager.mutateSnapshot('2025-10-11', (state) => {
      state.duplicatedInstances.push({
        instanceId: 'dup-2',
        originalPath: 'TASKS/second.md',
      });
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(updateDay).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(updateDay).toHaveBeenCalledTimes(2);
    expect(manager.snapshot('2025-10-10')?.duplicatedInstances).toEqual([
      expect.objectContaining({ instanceId: 'dup-1' }),
    ]);
    expect(manager.snapshot('2025-10-11')?.duplicatedInstances).toEqual([
      expect.objectContaining({ instanceId: 'dup-2' }),
    ]);
  });

  test('persist waits for an in-flight monthly mutation and saves the cleaned cache', async () => {
    const ghost = {
      instanceId: 'dup-persist-race',
      originalPath: 'TASKS/ghost.md',
    };
    const { deps, saveDay } = createDeps({
      '2025-10-10': createState({ duplicatedInstances: [ghost] }),
    });
    const baseUpdateDay = deps.dayStateService.updateDay;
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    deps.dayStateService.updateDay = jest.fn(async (
      date: Date,
      mutator: (state: DayState) => DayState | void,
    ) => {
      await mutationGate;
      return await baseUpdateDay(date, mutator);
    });
    const manager = new DayStateStoreService(deps);
    await manager.ensure('2025-10-10');

    const mutation = manager.mutateSnapshot('2025-10-10', (state) => {
      state.duplicatedInstances = state.duplicatedInstances.filter(
        (entry) => entry.instanceId !== ghost.instanceId,
      );
    });
    const persistence = manager.persist('2025-10-10');
    await Promise.resolve();
    await Promise.resolve();

    expect(saveDay).not.toHaveBeenCalled();
    releaseMutation();
    await Promise.all([mutation, persistence]);

    expect(saveDay).toHaveBeenCalledTimes(1);
    const saved = saveDay.mock.calls[0]?.[1] as DayState;
    expect(saved.duplicatedInstances).toEqual([]);
  });

  test('mutateSnapshot does not resurrect a cache cleared while persistence is pending', async () => {
    let resolveUpdate!: (state: DayState) => void;
    const updateResult = new Promise<DayState>((resolve) => {
      resolveUpdate = resolve;
    });
    const { deps } = createDeps();
    deps.dayStateService.updateDay = jest.fn(async (
      _date: Date,
      mutator: (state: DayState) => DayState | void,
    ) => {
      const state = createState();
      mutator(state);
      return await updateResult;
    });
    const manager = new DayStateStoreService(deps);

    const pending = manager.mutateSnapshot('2025-10-10', (state) => {
      state.duplicatedInstances.push({
        instanceId: 'dup-clear',
        originalPath: 'TASKS/clear.md',
      });
    });
    await Promise.resolve();
    manager.clear('2025-10-10');
    resolveUpdate(createState({
      duplicatedInstances: [{
        instanceId: 'dup-clear',
        originalPath: 'TASKS/clear.md',
      }],
    }));
    await pending;

    expect(manager.snapshot('2025-10-10')).toBeNull();
  });

  test('ensure retries instead of caching a load invalidated by clear', async () => {
    let resolveFirstLoad: ((state: DayState) => void) | undefined;
    const firstState = createState({
      hiddenRoutines: [{ path: 'TASKS/stale.md', instanceId: null }],
    });
    const freshState = createState({
      hiddenRoutines: [{ path: 'TASKS/fresh.md', instanceId: null }],
    });
    const { deps, loadDay } = createDeps();
    loadDay
      .mockImplementationOnce(async () => await new Promise<DayState>((resolve) => {
        resolveFirstLoad = resolve;
      }))
      .mockResolvedValueOnce(freshState);
    const manager = new DayStateStoreService(deps);

    const pending = manager.ensure('2025-10-10');
    await Promise.resolve();
    manager.clear('2025-10-10');
    resolveFirstLoad?.(firstState);
    const loaded = await pending;

    expect(loadDay).toHaveBeenCalledTimes(2);
    expect(loaded.hiddenRoutines).toEqual([
      expect.objectContaining({ path: 'TASKS/fresh.md' }),
    ]);
    expect(manager.snapshot('2025-10-10')).toBe(loaded);
  });

  test('setHidden replaces entries and persists', async () => {
    const { deps, saveDay } = createDeps();
    const manager = new DayStateStoreService(deps);

    manager.setHidden([
      { path: 'TASKS/hidden.md', instanceId: null, date: '2025-10-09' },
    ]);

    await manager.persist();

    const hidden = manager.getHidden();
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.path).toBe('TASKS/hidden.md');
    expect(saveDay).toHaveBeenCalled();
  });

  test('isDeleted respects permanent path deletions', async () => {
    const state = createState({
      deletedInstances: [
        {
          path: 'TASKS/remove.md',
          deletionType: 'permanent',
          timestamp: 1,
        },
      ],
    });
    const { deps } = createDeps({ '2025-10-09': state });
    const manager = new DayStateStoreService(deps);
    await manager.ensure();

    expect(manager.isDeleted({ path: 'TASKS/remove.md' })).toBe(true);
    expect(manager.isDeleted({ instanceId: 'missing', path: 'TASKS/other.md' })).toBe(false);
  });

  test('isDeleted treats legacy deletion without timestamp as deleted', async () => {
    const state = createState({
      deletedInstances: [
        {
          path: 'TASKS/legacy.md',
          deletionType: 'permanent',
        },
      ],
    });
    const { deps } = createDeps({ '2025-10-09': state });
    const manager = new DayStateStoreService(deps);
    await manager.ensure();

    expect(manager.isDeleted({ path: 'TASKS/legacy.md' })).toBe(true);
  });

  test('setDeleted keeps newest permanent deletion for same taskId', async () => {
    const { deps } = createDeps();
    const manager = new DayStateStoreService(deps);
    const dateKey = '2025-10-09';

    manager.setDeleted(
      [
        {
          taskId: 'task-1',
          path: 'TASKS/old.md',
          deletionType: 'permanent',
          deletedAt: 1000,
          restoredAt: 2000,
        },
        {
          taskId: 'task-1',
          path: 'TASKS/new.md',
          deletionType: 'permanent',
          deletedAt: 3000,
        },
      ],
      dateKey,
    );

    const entries = manager.getDeleted(dateKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.deletedAt).toBe(3000);
    expect(entries[0]?.restoredAt).toBeUndefined();
    expect(entries[0]?.path).toBe('TASKS/new.md');
  });

  test('renameTaskPath updates cache and delegates to persistence layer', async () => {
    const preset = createState({
      hiddenRoutines: [{ path: 'TASKS/old.md', instanceId: null }],
      deletedInstances: [
        {
          path: 'TASKS/old.md',
          deletionType: 'temporary',
          timestamp: Date.now(),
        },
      ],
      duplicatedInstances: [
        {
          instanceId: 'dup-1',
          originalPath: 'TASKS/old.md',
        },
      ],
      slotOverrides: {
        'TASKS/old.md': '8:00-12:00',
      },
      slotOverridesMeta: {
        'TASKS/old.md': { slotKey: '8:00-12:00', updatedAt: 123 },
      },
      orders: {
        'TASKS/old.md::none': 120,
      },
      ordersMeta: {
        'TASKS/old.md::none': { order: 120, updatedAt: 456 },
      },
      recipeProgress: {
        'task:TASKS/old.md::RECIPES/a.md': {
          recipePath: 'RECIPES/a.md',
          checkedStepIds: ['step-a'],
          updatedAt: 789,
        },
      },
    })

    const { deps } = createDeps({ '2025-10-09': preset })
    const manager = new DayStateStoreService(deps)

    await manager.ensure()
    await manager.renameTaskPath('TASKS/old.md', 'TASKS/new.md')

    expect(deps.dayStateService.renameTaskPath).toHaveBeenCalledWith('TASKS/old.md', 'TASKS/new.md')

    const state = manager.getStateFor('2025-10-09')
    expect(state.slotOverrides['TASKS/new.md']).toBe('8:00-12:00')
    expect(state.slotOverrides['TASKS/old.md']).toBeUndefined()
    expect(state.slotOverridesMeta?.['TASKS/new.md']?.updatedAt).toBe(123)
    expect(state.slotOverridesMeta?.['TASKS/old.md']).toBeUndefined()
    expect(state.orders['TASKS/new.md::none']).toBe(120)
    expect(state.ordersMeta?.['TASKS/new.md::none']?.updatedAt).toBe(456)
    expect(state.ordersMeta?.['TASKS/old.md::none']).toBeUndefined()
    expect(state.recipeProgress?.['task:TASKS/new.md::RECIPES/a.md']?.checkedStepIds).toEqual(['step-a'])
    expect(state.recipeProgress?.['task:TASKS/old.md::RECIPES/a.md']).toBeUndefined()
    expect(state.hiddenRoutines[0]?.path).toBe('TASKS/new.md')
    expect(state.deletedInstances[0]?.path).toBe('TASKS/new.md')
    expect(state.duplicatedInstances[0]?.originalPath).toBe('TASKS/new.md')
  })

  test('renameTaskPath migrates recipe progress when a recipe note path changes', async () => {
    const preset = createState({
      recipeProgress: {
        'task:task-1::RECIPES/old.md': {
          recipePath: 'RECIPES/old.md',
          checkedStepIds: ['step-a'],
          stepOrder: ['step-a', 'step-b'],
          completedAtByStepId: { 'step-a': '2025-10-09T10:00:00.000Z' },
          updatedAt: 789,
        },
        'TASKS/task.md_2025-10-09_123_dup::RECIPES/old.md': {
          recipePath: 'RECIPES/old.md',
          checkedStepIds: ['step-b'],
          updatedAt: 790,
        },
      },
    })

    const { deps } = createDeps({ '2025-10-09': preset })
    const manager = new DayStateStoreService(deps)

    await manager.ensure()
    await manager.renameTaskPath('RECIPES/old.md', 'RECIPES/new.md')

    expect(deps.dayStateService.renameTaskPath).toHaveBeenCalledWith('RECIPES/old.md', 'RECIPES/new.md')

    const state = manager.getStateFor('2025-10-09')
    expect(state.recipeProgress?.['task:task-1::RECIPES/new.md']).toEqual({
      recipePath: 'RECIPES/new.md',
      checkedStepIds: ['step-a'],
      stepOrder: ['step-a', 'step-b'],
      completedAtByStepId: { 'step-a': '2025-10-09T10:00:00.000Z' },
      updatedAt: 789,
    })
    expect(state.recipeProgress?.['TASKS/task.md_2025-10-09_123_dup::RECIPES/new.md']?.recipePath)
      .toBe('RECIPES/new.md')
    expect(state.recipeProgress?.['task:task-1::RECIPES/old.md']).toBeUndefined()
    expect(state.recipeProgress?.['TASKS/task.md_2025-10-09_123_dup::RECIPES/old.md']).toBeUndefined()
  })

  describe('clear', () => {
    test('clear without dateKey clears all cache and calls persistence clearCache', async () => {
      const preset = createState({ hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }] });
      const { deps } = createDeps({ '2025-10-09': preset });
      const manager = new DayStateStoreService(deps);

      // Load state into cache
      await manager.ensure();
      expect(manager.snapshot('2025-10-09')).not.toBeNull();

      // Clear all caches
      manager.clear();

      // Local cache should be cleared
      expect(manager.snapshot('2025-10-09')).toBeNull();
      expect(manager.getCurrentKey()).toBeNull();

      // Persistence layer's cache should also be cleared
      expect(deps.dayStateService.clearCache).toHaveBeenCalled();
    });

    test('clear with specific dateKey only clears that date and clears month cache for that date', async () => {
      const preset1 = createState({ hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }] });
      const preset2 = createState({ hiddenRoutines: [{ path: 'TASKS/bar.md', instanceId: null }] });
      const { deps } = createDeps({ '2025-10-09': preset1, '2025-10-10': preset2 });
      const manager = new DayStateStoreService(deps);

      // Load states into cache
      await manager.ensure('2025-10-09');
      await manager.ensure('2025-10-10');

      // Clear only one date
      manager.clear('2025-10-10');

      // Only specified date should be cleared
      expect(manager.snapshot('2025-10-09')).not.toBeNull();
      expect(manager.snapshot('2025-10-10')).toBeNull();

      // Persistence layer's full cache should NOT be called for single-date clear
      expect(deps.dayStateService.clearCache).not.toHaveBeenCalled();
      expect(deps.dayStateService.clearCacheForDate).toHaveBeenCalledWith('2025-10-10');
    });

    test('clear enables fresh reload from file on next ensure', async () => {
      const preset = createState({ hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }] });
      const { deps, loadDay } = createDeps({ '2025-10-09': preset });
      const manager = new DayStateStoreService(deps);

      // First load
      await manager.ensure();
      expect(loadDay).toHaveBeenCalledTimes(1);

      // Second load should use cache, not call loadDay
      await manager.ensure();
      expect(loadDay).toHaveBeenCalledTimes(1);

      // Clear cache
      manager.clear();

      // Third load should call loadDay again since cache is cleared
      await manager.ensure();
      expect(loadDay).toHaveBeenCalledTimes(2);
    });
  });
});
