import DayStateManager from '../../src/services/DayStateManager';
import { DayState } from '../../src/types';

describe('DayStateManager', () => {
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
    const manager = new DayStateManager(deps);

    const state = await manager.ensure();

    expect(loadDay).toHaveBeenCalledTimes(1);
    expect(state.hiddenRoutines).toHaveLength(1);
    expect(manager.snapshot('2025-10-09')).toEqual(state);
  });

  test('setHidden replaces entries and persists', async () => {
    const { deps, saveDay } = createDeps();
    const manager = new DayStateManager(deps);

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
    const manager = new DayStateManager(deps);
    await manager.ensure();

    expect(manager.isDeleted({ path: 'TASKS/remove.md' })).toBe(true);
    expect(manager.isDeleted({ instanceId: 'missing', path: 'TASKS/other.md' })).toBe(false);
  });
});
