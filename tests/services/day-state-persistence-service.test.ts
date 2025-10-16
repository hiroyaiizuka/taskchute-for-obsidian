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

