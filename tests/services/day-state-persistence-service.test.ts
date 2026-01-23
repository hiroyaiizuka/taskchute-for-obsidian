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

  it('consumes local write markers after saving state', async () => {
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
    expect(service.consumeLocalStateWrite(path)).toBe(true)
    expect(service.consumeLocalStateWrite(path)).toBe(false)
  })

  it('records local writes before modifying existing files', async () => {
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
      expect(service.consumeLocalStateWrite(file.path)).toBe(true)
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
