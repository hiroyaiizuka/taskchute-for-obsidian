/**
 * Write Barrier tests for DayStateStoreService
 * Verifies that persist/persistAsync are suppressed during barrier,
 * and flushed with mergeAndSaveMonth on endWriteBarrier.
 */
import { DayStateStoreService } from '../../src/services/DayStateStoreService'
import type { DayState, DayStateServiceAPI } from '../../src/types'

function createEmptyState(): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
  }
}

function createMockDayStateService(): DayStateServiceAPI & {
  saveDay: jest.Mock
  mergeAndSaveMonth: jest.Mock
  loadDay: jest.Mock
} {
  return {
    loadDay: jest.fn(async () => createEmptyState()),
    saveDay: jest.fn(async () => undefined),
    mergeDayState: jest.fn(async () => undefined),
    clearCache: jest.fn(async () => undefined),
    clearCacheForDate: jest.fn(),
    getDateFromKey: jest.fn((key: string) => {
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d)
    }),
    renameTaskPath: jest.fn(async () => undefined),
    consumeLocalStateWrite: jest.fn(() => false),
    mergeAndSaveMonth: jest.fn(async () => undefined),
  }
}

describe('DayStateStoreService Write Barrier', () => {
  it('suppresses persist during barrier and flushes on endWriteBarrier', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    // Set up state in cache
    await store.ensure('2026-02-19')
    mockService.saveDay.mockClear()

    // Begin barrier
    store.beginWriteBarrier()
    expect(store.isBarrierActive()).toBe(true)

    // Modify state and persist — should be suppressed
    const state = store.getStateFor('2026-02-19')
    state.deletedInstances.push({
      path: 'TASKS/test.md',
      deletionType: 'permanent',
      deletedAt: Date.now(),
    })
    await store.persist('2026-02-19')

    // saveDay should NOT have been called during barrier
    expect(mockService.saveDay).not.toHaveBeenCalled()

    // End barrier — should flush via mergeAndSaveMonth
    await store.endWriteBarrier()
    expect(store.isBarrierActive()).toBe(false)

    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(1)
    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledWith(
      '2026-02',
      expect.any(Map),
    )

    // Verify the Map contains our dateKey
    const passedMap = mockService.mergeAndSaveMonth.mock.calls[0][1] as Map<string, DayState>
    expect(passedMap.has('2026-02-19')).toBe(true)
  })

  it('resumes normal persist after barrier is ended', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')
    mockService.saveDay.mockClear()

    store.beginWriteBarrier()
    await store.endWriteBarrier()

    // After barrier, persist should call saveDay normally
    await store.persist('2026-02-19')
    expect(mockService.saveDay).toHaveBeenCalledTimes(1)
  })

  it('handles nested barriers — only flushes on outermost end', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')
    mockService.saveDay.mockClear()

    // Nested barriers
    store.beginWriteBarrier()
    store.beginWriteBarrier()
    expect(store.isBarrierActive()).toBe(true)

    await store.persist('2026-02-19')
    expect(mockService.saveDay).not.toHaveBeenCalled()

    // First end — still nested
    await store.endWriteBarrier()
    expect(store.isBarrierActive()).toBe(true)
    expect(mockService.mergeAndSaveMonth).not.toHaveBeenCalled()

    // Trigger a persist while still in nested barrier
    const state = store.getStateFor('2026-02-19')
    state.orders['test-key'] = 1
    await store.persist('2026-02-19')

    // Second end — outermost, should flush
    await store.endWriteBarrier()
    expect(store.isBarrierActive()).toBe(false)
    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(1)
  })

  it('cache is updated during barrier even though disk writes are suppressed', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')

    store.beginWriteBarrier()

    // Modify state via setDeleted
    store.setDeleted([
      { path: 'TASKS/foo.md', deletionType: 'permanent', deletedAt: Date.now() },
    ], '2026-02-19')

    // Cache should reflect the change immediately
    const deleted = store.getDeleted('2026-02-19')
    expect(deleted.length).toBe(1)
    expect(deleted[0].path).toBe('TASKS/foo.md')

    await store.endWriteBarrier()
  })

  it('falls back to saveDay when mergeAndSaveMonth is not available', async () => {
    const mockService = createMockDayStateService()
    // Remove mergeAndSaveMonth
    delete (mockService as Record<string, unknown>).mergeAndSaveMonth

    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')
    mockService.saveDay.mockClear()

    store.beginWriteBarrier()
    await store.persist('2026-02-19')
    expect(mockService.saveDay).not.toHaveBeenCalled()

    await store.endWriteBarrier()

    // Should fallback to saveDay
    expect(mockService.saveDay).toHaveBeenCalledTimes(1)
  })

  it('does not flush if no writes occurred during barrier', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    store.beginWriteBarrier()
    await store.endWriteBarrier()

    expect(mockService.mergeAndSaveMonth).not.toHaveBeenCalled()
    expect(mockService.saveDay).not.toHaveBeenCalled()
  })

  it('handles multiple month keys in a single barrier session', async () => {
    const mockService = createMockDayStateService()
    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-28',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    // Ensure both month states
    await store.ensure('2026-02-28')
    await store.ensure('2026-03-01')
    mockService.saveDay.mockClear()

    store.beginWriteBarrier()

    await store.persist('2026-02-28')
    await store.persist('2026-03-01')

    await store.endWriteBarrier()

    // Should call mergeAndSaveMonth for each month
    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(2)
    const monthKeys = mockService.mergeAndSaveMonth.mock.calls.map(
      (call: [string, Map<string, DayState>]) => call[0],
    )
    expect(monthKeys).toContain('2026-02')
    expect(monthKeys).toContain('2026-03')
  })

  it('retains pending writes and rejects when flush and fallback both fail', async () => {
    const mockService = createMockDayStateService()
    mockService.mergeAndSaveMonth.mockRejectedValueOnce(new Error('merge failed'))
    mockService.saveDay.mockRejectedValueOnce(new Error('save failed'))

    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')
    store.beginWriteBarrier()
    await store.persist('2026-02-19')

    await expect(store.endWriteBarrier()).rejects.toThrow(
      '[DayStateStoreService] Failed to flush pending day states',
    )

    const internals = store as unknown as {
      pendingWriteMonthKeys: Set<string>
      pendingWriteDateKeys: Set<string>
    }
    expect(internals.pendingWriteMonthKeys.has('2026-02')).toBe(true)
    expect(internals.pendingWriteDateKeys.has('2026-02-19')).toBe(true)

    // Retry in a later barrier session should flush retained pending writes.
    store.beginWriteBarrier()
    await store.endWriteBarrier()

    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(2)
    expect(internals.pendingWriteMonthKeys.size).toBe(0)
    expect(internals.pendingWriteDateKeys.size).toBe(0)
  })

  it('retains pending state snapshot across cache clear after failed flush', async () => {
    const mockService = createMockDayStateService()
    mockService.mergeAndSaveMonth.mockRejectedValueOnce(new Error('merge failed'))
    mockService.saveDay.mockRejectedValueOnce(new Error('save failed'))

    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')

    store.beginWriteBarrier()
    const state = store.getStateFor('2026-02-19')
    state.orders['local-only'] = 42
    await store.persist('2026-02-19')

    await expect(store.endWriteBarrier()).rejects.toThrow(
      '[DayStateStoreService] Failed to flush pending day states',
    )

    // Simulate next loadTasks cycle clearing and reloading current day cache.
    store.clear('2026-02-19')
    await store.ensure('2026-02-19')

    // Retry flush in a later barrier session.
    store.beginWriteBarrier()
    await store.endWriteBarrier()

    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(2)
    const retryMap = mockService.mergeAndSaveMonth.mock.calls[1][1] as Map<string, DayState>
    expect(retryMap.get('2026-02-19')?.orders).toEqual({ 'local-only': 42 })
  })

  it('does not reflush stale snapshot after non-barrier persist succeeds', async () => {
    const mockService = createMockDayStateService()
    mockService.mergeAndSaveMonth.mockRejectedValueOnce(new Error('merge failed'))
    mockService.saveDay.mockRejectedValueOnce(new Error('save failed'))

    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')

    store.beginWriteBarrier()
    const state = store.getStateFor('2026-02-19')
    state.orders['stale'] = 1
    await store.persist('2026-02-19')

    await expect(store.endWriteBarrier()).rejects.toThrow(
      '[DayStateStoreService] Failed to flush pending day states',
    )

    // Recovery write outside barrier succeeds and should supersede stale pending snapshot.
    const recovered = store.getStateFor('2026-02-19')
    recovered.orders['stale'] = 2
    await store.persist('2026-02-19')

    // Next barrier session should not reflush retained stale snapshot for this key.
    store.beginWriteBarrier()
    await store.endWriteBarrier()

    expect(mockService.mergeAndSaveMonth).toHaveBeenCalledTimes(1)

    const internals = store as unknown as {
      pendingWriteDateKeys: Set<string>
      pendingWriteSnapshots: Map<string, DayState>
    }
    expect(internals.pendingWriteDateKeys.has('2026-02-19')).toBe(false)
    expect(internals.pendingWriteSnapshots.has('2026-02-19')).toBe(false)
  })

  it('syncs store cache with merged state after mergeAndSaveMonth success', async () => {
    const mockService = createMockDayStateService()
    const mergedState: DayState = {
      ...createEmptyState(),
      orders: { 'task-a': 99 },
      ordersMeta: { 'task-a': { order: 99, updatedAt: 2000 } },
    }

    const store = new DayStateStoreService({
      dayStateService: mockService,
      getCurrentDateString: () => '2026-02-19',
      parseDateString: (key) => {
        const [y, m, d] = key.split('-').map(Number)
        return new Date(y, m - 1, d)
      },
    })

    await store.ensure('2026-02-19')

    const localState = store.getStateFor('2026-02-19')
    localState.orders['task-a'] = 1
    localState.ordersMeta = { 'task-a': { order: 1, updatedAt: 1000 } }

    mockService.mergeAndSaveMonth.mockResolvedValue(undefined)
    mockService.loadDay.mockImplementation(async () => mergedState)
    mockService.saveDay.mockClear()

    store.beginWriteBarrier()
    await store.persist('2026-02-19')
    await store.endWriteBarrier()

    // If cache sync is missing, this persist re-saves stale local order (=1).
    await store.persist('2026-02-19')

    expect(mockService.saveDay).toHaveBeenCalledTimes(1)
    const savedState = mockService.saveDay.mock.calls[0][1] as DayState
    expect(savedState.orders['task-a']).toBe(99)
    expect(savedState.ordersMeta?.['task-a']).toEqual({ order: 99, updatedAt: 2000 })
  })
})
