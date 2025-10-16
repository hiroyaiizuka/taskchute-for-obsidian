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
    const deps = {
      dayStateService: {
        loadDay,
        saveDay,
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
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

    return { deps, loadDay, saveDay, cache };
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
      orders: {
        'TASKS/old.md::none': 120,
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
    expect(state.orders['TASKS/new.md::none']).toBe(120)
    expect(state.hiddenRoutines[0]?.path).toBe('TASKS/new.md')
    expect(state.deletedInstances[0]?.path).toBe('TASKS/new.md')
    expect(state.duplicatedInstances[0]?.originalPath).toBe('TASKS/new.md')
  })
});
