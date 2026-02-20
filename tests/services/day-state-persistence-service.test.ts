import { TFile } from 'obsidian'
import DayStatePersistenceService from '../../src/services/DayStatePersistenceService'
import type { TaskChutePluginLike } from '../../src/types'

describe('DayStatePersistenceService.renameTaskPath', () => {
  const createPlugin = () => {
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
      adapter: {
        read: jest.fn(async (path: string) => store.get(path) ?? ''),
        write: jest.fn(async (path: string, content: string) => {
          store.set(path, content)
        }),
      },
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
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager,
      routineAliasService: {
        loadAliases: jest.fn().mockResolvedValue({}),
      },
      dayStateService: {} as unknown,
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskChutePluginLike

    return { plugin, store, pathManager, vault }
  }

  it('updates stored state files and cache entries', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    store.set(
      'LOGS/2025-09-state.json',
      JSON.stringify(
        {
          days: {
            '2025-09-14': {
              hiddenRoutines: [{ path: 'TASKS/old.md', instanceId: null }],
              deletedInstances: [
                { path: 'TASKS/old.md', deletionType: 'temporary', timestamp: 1 },
              ],
              duplicatedInstances: [
                {
                  instanceId: 'dup-1',
                  originalPath: 'TASKS/old.md',
                },
              ],
              slotOverrides: { 'TASKS/old.md': '8:00-12:00' },
              orders: { 'TASKS/old.md::none': 200 },
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2025-09-14T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const targetDate = new Date('2025-09-14T00:00:00.000Z')
    await service.loadDay(targetDate)

    await service.renameTaskPath('TASKS/old.md', 'TASKS/new.md')

    expect(vault.modify).toHaveBeenCalled()

    const updatedPayload = JSON.parse(store.get('LOGS/2025-09-state.json') ?? '{}')
    const day = updatedPayload.days['2025-09-14']
    expect(day.slotOverrides['TASKS/new.md']).toBe('8:00-12:00')
    expect(day.slotOverrides['TASKS/old.md']).toBeUndefined()
    expect(day.orders['TASKS/new.md::none']).toBe(200)
    expect(day.hiddenRoutines[0]?.path).toBe('TASKS/new.md')
    expect(day.deletedInstances[0]?.path).toBe('TASKS/new.md')
    expect(day.duplicatedInstances[0]?.originalPath).toBe('TASKS/new.md')

    const cached = await service.loadDay(targetDate)
    expect(cached.slotOverrides['TASKS/new.md']).toBe('8:00-12:00')
  })
})

describe('DayStatePersistenceService.loadDay', () => {
  const createPlugin = () => {
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
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager,
      routineAliasService: {
        loadAliases: jest.fn().mockResolvedValue({}),
      },
      dayStateService: {} as unknown,
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskChutePluginLike

    return { plugin, store, pathManager, vault }
  }

  it('does not create month files when loading missing day state', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-09T00:00:00.000Z')
    const state = await service.loadDay(date)

    expect(vault.create).not.toHaveBeenCalled()
    expect(vault.modify).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
    expect(state.hiddenRoutines).toEqual([])
    expect(state.deletedInstances).toEqual([])
    expect(state.duplicatedInstances).toEqual([])
    expect(state.slotOverrides).toEqual({})
    expect(state.orders).toEqual({})
  })

  it('does not modify existing month files when the day entry is missing', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-08': {
              hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {},
              orders: {},
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-08T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )
    const before = store.get('LOGS/2026-01-state.json')

    const date = new Date('2026-01-09T00:00:00.000Z')
    await service.loadDay(date)

    expect(vault.modify).not.toHaveBeenCalled()
    expect(store.get('LOGS/2026-01-state.json')).toBe(before)
  })

  it('restores slotOverridesMeta and ordersMeta when loading day state', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-09': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {
                'TASKS/foo.md': '8:00-12:00',
              },
              slotOverridesMeta: {
                'TASKS/foo.md': { slotKey: '8:00-12:00', updatedAt: 1700000000000 },
              },
              orders: {
                'TASKS/foo.md::none': 200,
              },
              ordersMeta: {
                'TASKS/foo.md::none': { order: 200, updatedAt: 1700000000000 },
              },
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-09T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const date = new Date('2026-01-09T00:00:00.000Z')
    const state = await service.loadDay(date)

    expect(state.slotOverridesMeta).toEqual({
      'TASKS/foo.md': { slotKey: '8:00-12:00', updatedAt: 1700000000000 },
    })
    expect(state.ordersMeta).toEqual({
      'TASKS/foo.md::none': { order: 200, updatedAt: 1700000000000 },
    })
  })

  it('creates month files when saving day state', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-09T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    expect(vault.create).toHaveBeenCalled()
    expect(store.has('LOGS/2026-01-state.json')).toBe(true)
  })
})

describe('DayStatePersistenceService.mergeExternalChange', () => {
  const createPlugin = () => {
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
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager,
      routineAliasService: {
        loadAliases: jest.fn().mockResolvedValue({}),
      },
      dayStateService: {} as unknown,
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskChutePluginLike

    return { plugin, store, vault }
  }

  it('preserves ordersMeta in merged day state', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-09T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: { 'TASKS/foo.md::none': 100 },
      ordersMeta: {
        'TASKS/foo.md::none': { order: 100, updatedAt: 1000 },
      },
    })

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-09': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {},
              orders: { 'TASKS/foo.md::none': 200 },
              ordersMeta: {
                'TASKS/foo.md::none': { order: 200, updatedAt: 2000 },
              },
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-09T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const result = await service.mergeExternalChange('2026-01')

    expect(result.merged?.days['2026-01-09']?.ordersMeta).toEqual({
      'TASKS/foo.md::none': { order: 200, updatedAt: 2000 },
    })
  })

  it('keeps order value aligned with newer ordersMeta', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-10T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: { 'TASKS/foo.md::none': 300 },
      ordersMeta: {
        'TASKS/foo.md::none': { order: 300, updatedAt: 2000 },
      },
    })

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-10': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {},
              orders: { 'TASKS/foo.md::none': 100 },
              ordersMeta: {
                'TASKS/foo.md::none': { order: 100, updatedAt: 1000 },
              },
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-10T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const result = await service.mergeExternalChange('2026-01')

    expect(result.merged?.days['2026-01-10']?.orders['TASKS/foo.md::none']).toBe(300)
    expect(result.merged?.days['2026-01-10']?.ordersMeta).toEqual({
      'TASKS/foo.md::none': { order: 300, updatedAt: 2000 },
    })
  })

  it('drops local orders when remote removes a key without ordersMeta', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-12T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: { 'TASKS/foo.md::none': 150 },
    })

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-12': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {},
              orders: {},
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-12T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const result = await service.mergeExternalChange('2026-01')

    expect(result.merged?.days['2026-01-12']?.orders).toEqual({})
  })

  it('removes duplicatedInstances when a matching temporary deletion exists', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-11T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [],
      deletedInstances: [
        {
          instanceId: 'dup-1',
          path: 'TASKS/dup.md',
          deletionType: 'temporary',
          deletedAt: 2000,
        },
      ],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-11': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [
                {
                  instanceId: 'dup-1',
                  originalPath: 'TASKS/dup.md',
                  timestamp: 1000,
                  createdMillis: 1000,
                },
              ],
              slotOverrides: {},
              orders: {},
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-11T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const result = await service.mergeExternalChange('2026-01')

    const mergedDay = result.merged?.days['2026-01-11']
    expect(mergedDay?.duplicatedInstances).toHaveLength(0)
  })

  it('does not persist when duplicate conflicts do not change merged local day', async () => {
    const { plugin, store, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-01-13T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [
        {
          instanceId: 'dup-1',
          originalPath: 'TASKS/dup.md',
          timestamp: 1000,
          createdMillis: 1000,
          slotKey: '8:00-12:00',
        },
      ],
      slotOverrides: {},
      orders: {},
    })

    vault.modify.mockClear()

    store.set(
      'LOGS/2026-01-state.json',
      JSON.stringify(
        {
          days: {
            '2026-01-13': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [
                {
                  instanceId: 'dup-1',
                  originalPath: 'TASKS/dup.md',
                  timestamp: 1000,
                  createdMillis: 1000,
                  slotKey: '12:00-16:00',
                },
              ],
              slotOverrides: {},
              orders: {},
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-01-13T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const result = await service.mergeExternalChange('2026-01')

    expect(vault.modify).not.toHaveBeenCalled()
    expect(result.affectedDateKeys).toEqual([])
    expect(result.merged?.days['2026-01-13']?.duplicatedInstances).toEqual([
      expect.objectContaining({
        instanceId: 'dup-1',
        slotKey: '8:00-12:00',
      }),
    ])
  })
})

describe('DayStatePersistenceService local write tracking', () => {
  const createPlugin = () => {
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
      settings: {
        useOrderBasedSort: true,
        slotKeys: {},
      },
      pathManager,
      routineAliasService: {
        loadAliases: jest.fn().mockResolvedValue({}),
      },
      dayStateService: {} as unknown,
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskChutePluginLike

    return { plugin, store, pathManager, vault }
  }

  it('consumes local write markers after saving state (hash-based)', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-02-01T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    const path = 'LOGS/2026-02-state.json'
    // Read the actual content that was written to the store
    const writtenContent = store.get(path) ?? ''
    // With matching content, consume returns true
    expect(service.consumeLocalStateWrite(path, writtenContent)).toBe(true)
    // After consuming, same content should return false (hash was removed)
    expect(service.consumeLocalStateWrite(path, writtenContent)).toBe(false)
  })

  it('consumeLocalStateWrite returns false when content is omitted', async () => {
    const { plugin } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-02-01T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    const path = 'LOGS/2026-02-state.json'
    // Without content, returns false (safe side: treat as external change)
    expect(service.consumeLocalStateWrite(path)).toBe(false)
  })

  it('consumeLocalStateWrite returns false when content differs', async () => {
    const { plugin } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-02-01T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    const path = 'LOGS/2026-02-state.json'
    // With different content (external change), returns false
    expect(service.consumeLocalStateWrite(path, '{"different": "content"}')).toBe(false)
  })

  it('does not consume local write hash recorded after event timestamp', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)

    const date = new Date('2026-02-01T00:00:00.000Z')
    const eventTimestamp = Date.now() - 1000

    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    const path = 'LOGS/2026-02-state.json'
    const writtenContent = store.get(path) ?? ''

    // Hash recorded after event timestamp should not be consumed
    expect(service.consumeLocalStateWrite(path, writtenContent, eventTimestamp)).toBe(false)

    // Without timestamp guard, the same local write marker is consumable
    expect(service.consumeLocalStateWrite(path, writtenContent)).toBe(true)
  })

  it('records local writes before modifying existing files (hash-based)', async () => {
    const { plugin, store, vault } = createPlugin()
    store.set(
      'LOGS/2026-03-state.json',
      JSON.stringify(
        {
          days: {
            '2026-03-01': {
              hiddenRoutines: [],
              deletedInstances: [],
              duplicatedInstances: [],
              slotOverrides: {},
              orders: {},
            },
          },
          metadata: {
            version: '1.0',
            lastUpdated: '2026-03-01T00:00:00.000Z',
          },
        },
        null,
        2,
      ),
    )

    const service = new DayStatePersistenceService(plugin)
    vault.modify = jest.fn(async (file: TFile, content: string) => {
      // With matching content, consume returns true
      expect(service.consumeLocalStateWrite(file.path, content)).toBe(true)
      store.set(file.path, content)
    })

    const date = new Date('2026-03-01T00:00:00.000Z')
    await service.saveDay(date, {
      hiddenRoutines: [{ path: 'TASKS/foo.md', instanceId: null }],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })

    expect(vault.modify).toHaveBeenCalled()
  })
})
