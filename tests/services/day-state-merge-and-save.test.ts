/**
 * mergeAndSaveMonth tests for DayStatePersistenceService
 * Verifies that local DayState changes are merged with on-disk data before saving.
 */
import { TFile } from 'obsidian'
import DayStatePersistenceService from '../../src/services/DayStatePersistenceService'
import type { DayState, TaskChutePluginLike } from '../../src/types'

function createEmptyDayState(): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
  }
}

function createPlugin() {
  const store = new Map<string, string>()

  const createFile = (path: string) => {
    const file = new TFile()
    file.path = path
    Object.setPrototypeOf(file, TFile.prototype)
    return file
  }

  const vault = {
    getAbstractFileByPath: jest.fn((path: string) =>
      store.has(path) ? createFile(path) : null,
    ),
    read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
    create: jest.fn(async (path: string, content: string) => {
      store.set(path, content)
      return createFile(path)
    }),
    modify: jest.fn(async (file: TFile, content: string) => {
      store.set(file.path, content)
    }),
  }

  const pathManager = {
    getTaskFolderPath: () => 'TASKS',
    getProjectFolderPath: () => 'PROJECTS',
    getLogDataPath: () => 'LOGS',
    getReviewDataPath: () => 'REVIEWS',
    ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    getLogYearPath: jest.fn((year: string | number) => `LOGS/${year}`),
    ensureYearFolder: jest.fn(async () => undefined),
    validatePath: jest.fn(() => ({ valid: true })),
  }

  const plugin = {
    app: { vault },
    settings: { useOrderBasedSort: true, slotKeys: {} },
    pathManager,
    routineAliasService: { loadAliases: jest.fn().mockResolvedValue({}) },
    dayStateService: {} as unknown,
    saveSettings: jest.fn().mockResolvedValue(undefined),
  } as unknown as TaskChutePluginLike

  return { plugin, store, vault }
}

describe('DayStatePersistenceService.mergeAndSaveMonth', () => {
  it('merges local deletions with disk deletions (both preserved)', async () => {
    const { plugin, store } = createPlugin()

    // Disk has PC deletion
    const diskState = {
      days: {
        '2026-02-19': {
          hiddenRoutines: [],
          deletedInstances: [
            { path: 'TASKS/pc-deleted.md', deletionType: 'permanent', deletedAt: 1000 },
          ],
          duplicatedInstances: [],
          slotOverrides: {},
          orders: {},
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    // Local has mobile promotion write
    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      hiddenRoutines: [],
      deletedInstances: [
        { path: 'TASKS/mobile-promoted.md', deletionType: 'permanent', deletedAt: 2000, taskId: 'task-123' },
      ],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    // Read the saved result
    const savedRaw = store.get('LOGS/2026-02-state.json')
    expect(savedRaw).toBeDefined()
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    // Both deletions should be preserved
    expect(dayState.deletedInstances).toHaveLength(2)
    const paths = dayState.deletedInstances.map((d) => d.path)
    expect(paths).toContain('TASKS/pc-deleted.md')
    expect(paths).toContain('TASKS/mobile-promoted.md')
  })

  it('merges orders with timestamp-based conflict resolution', async () => {
    const { plugin, store } = createPlugin()

    const diskState = {
      days: {
        '2026-02-19': {
          ...createEmptyDayState(),
          orders: { 'task-a': 1, 'task-b': 2 },
          ordersMeta: {
            'task-a': { order: 1, updatedAt: 100 },
            'task-b': { order: 2, updatedAt: 200 },
          },
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      orders: { 'task-a': 10, 'task-b': 2 },
      ordersMeta: {
        'task-a': { order: 10, updatedAt: 300 }, // newer
        'task-b': { order: 2, updatedAt: 100 }, // older
      },
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    // task-a: local wins (updatedAt 300 > 100)
    expect(dayState.orders['task-a']).toBe(10)
    // task-b: disk wins (updatedAt 200 > 100)
    expect(dayState.orders['task-b']).toBe(2)
  })

  it('keeps local meta-backed order key when disk month is newer due to unrelated update', async () => {
    const { plugin, store } = createPlugin()

    const orderKey = 'task-a::none'
    const diskState = {
      days: {
        '2026-02-19': {
          ...createEmptyDayState(),
          orders: {},
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:10.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      hiddenRoutines: [{ path: 'TASKS/local-hidden.md', hiddenAt: 1234 }],
      orders: { [orderKey]: 10 },
      ordersMeta: { [orderKey]: { order: 10, updatedAt: 1000 } },
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    expect(dayState.orders[orderKey]).toBe(10)
    expect(dayState.ordersMeta?.[orderKey]).toEqual({ order: 10, updatedAt: 1000 })
    expect(dayState.hiddenRoutines).toEqual([{ path: 'TASKS/local-hidden.md', hiddenAt: 1234 }])
  })

  it('preserves local removal of invalid-slot order keys without ordersMeta', async () => {
    const { plugin, store } = createPlugin()

    const invalidRemoteKey = 'legacy-task::25:00-26:00'
    const validLocalKey = 'task-a::8:00-12:00'
    const diskState = {
      days: {
        '2026-02-19': {
          ...createEmptyDayState(),
          orders: { [invalidRemoteKey]: 99 },
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      orders: { [validLocalKey]: 10 },
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    expect(dayState.orders).toEqual({ [validLocalKey]: 10 })
    expect(dayState.orders[invalidRemoteKey]).toBeUndefined()
  })

  it('keeps remote no-meta order updates while preserving local changes in other fields', async () => {
    const { plugin, store } = createPlugin()

    const orderKey = 'task-a::8:00-12:00'
    const diskState = {
      days: {
        '2026-02-19': {
          ...createEmptyDayState(),
          orders: { [orderKey]: 50 },
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      // Local write touched non-order field while keeping stale order value.
      hiddenRoutines: [{ path: 'TASKS/local-hidden.md', hiddenAt: 1234 }],
      orders: { [orderKey]: 10 },
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    // no-meta conflicting key should keep remote order to avoid rolling back external sync updates.
    expect(dayState.orders[orderKey]).toBe(50)
    // Local non-order change should still be preserved by the merge.
    expect(dayState.hiddenRoutines).toEqual([{ path: 'TASKS/local-hidden.md', hiddenAt: 1234 }])
  })

  it('merges duplicatedInstances and suppresses deleted ones', async () => {
    const { plugin, store } = createPlugin()

    const diskState = {
      days: {
        '2026-02-19': {
          ...createEmptyDayState(),
          duplicatedInstances: [
            { instanceId: 'dup-1', originalPath: 'TASKS/task.md', originalTaskId: 'task-1' },
          ],
          deletedInstances: [
            { instanceId: 'dup-1', deletionType: 'temporary', deletedAt: 5000 },
          ],
        },
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      duplicatedInstances: [
        { instanceId: 'dup-1', originalPath: 'TASKS/task.md', originalTaskId: 'task-1' },
        { instanceId: 'dup-2', originalPath: 'TASKS/task2.md', originalTaskId: 'task-2' },
      ],
    })

    await service.mergeAndSaveMonth('2026-02', localDayStates)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    const dayState = saved.days['2026-02-19']

    // dup-1 should be suppressed (temporary deletion exists)
    // dup-2 should be preserved
    expect(dayState.duplicatedInstances).toHaveLength(1)
    expect(dayState.duplicatedInstances[0].instanceId).toBe('dup-2')
  })

  it('handles multiple dateKeys in one month with single I/O', async () => {
    const { plugin, store, vault } = createPlugin()

    const diskState = {
      days: {
        '2026-02-18': createEmptyDayState(),
        '2026-02-19': createEmptyDayState(),
      },
      metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
    }
    store.set('LOGS/2026-02-state.json', JSON.stringify(diskState, null, 2))

    const service = new DayStatePersistenceService(plugin)

    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-18', {
      ...createEmptyDayState(),
      deletedInstances: [{ path: 'TASKS/a.md', deletionType: 'permanent', deletedAt: 100 }],
    })
    localDayStates.set('2026-02-19', {
      ...createEmptyDayState(),
      deletedInstances: [{ path: 'TASKS/b.md', deletionType: 'permanent', deletedAt: 200 }],
    })

    vault.modify.mockClear()
    await service.mergeAndSaveMonth('2026-02', localDayStates)

    // Should write only once (single I/O for the month)
    const writeCount = vault.modify.mock.calls.length + vault.create.mock.calls.length
    expect(writeCount).toBe(1)

    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    expect(saved.days['2026-02-18'].deletedInstances).toHaveLength(1)
    expect(saved.days['2026-02-19'].deletedInstances).toHaveLength(1)
  })

  it('does nothing when localDayStates is empty', async () => {
    const { plugin, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    vault.modify.mockClear()
    vault.create.mockClear()
    await service.mergeAndSaveMonth('2026-02', new Map())

    expect(vault.modify).not.toHaveBeenCalled()
    expect(vault.create).not.toHaveBeenCalled()
  })

  it('does not leave cache in merged state when write fails, so saveDay fallback can persist', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    store.set(
      'LOGS/2026-02-state.json',
      JSON.stringify(
        {
          days: {
            '2026-02-19': createEmptyDayState(),
          },
          metadata: { version: '1.0', lastUpdated: '2026-02-19T00:00:00.000Z' },
        },
        null,
        2,
      ),
    )

    const fallbackState: DayState = {
      ...createEmptyDayState(),
      deletedInstances: [
        {
          path: 'TASKS/fallback.md',
          deletionType: 'permanent',
          deletedAt: 999,
          taskId: 'fallback-task',
        },
      ],
    }
    const localDayStates = new Map<string, DayState>()
    localDayStates.set('2026-02-19', fallbackState)

    vault.modify.mockImplementationOnce(async () => {
      throw new Error('simulated write failure')
    })

    await expect(service.mergeAndSaveMonth('2026-02', localDayStates)).rejects.toThrow(
      'simulated write failure',
    )

    const monthCache = (service as unknown as {
      cache: Map<string, { days: Record<string, DayState> }>
    }).cache.get('2026-02')
    expect(monthCache?.days['2026-02-19']).toEqual(createEmptyDayState())

    await service.saveDay(new Date(2026, 1, 19), fallbackState)

    expect(vault.modify).toHaveBeenCalledTimes(2)
    const savedRaw = store.get('LOGS/2026-02-state.json')
    const saved = JSON.parse(savedRaw!) as { days: Record<string, DayState> }
    expect(saved.days['2026-02-19'].deletedInstances).toHaveLength(1)
    expect(saved.days['2026-02-19'].deletedInstances[0].path).toBe('TASKS/fallback.md')
  })
})
