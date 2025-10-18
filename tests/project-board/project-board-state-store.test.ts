import type { TaskChutePluginLike, ProjectBoardState } from '../../src/types'
import { ProjectBoardStateStore } from '../../src/services/projects'

function createPlugin(options?: {
  exists?: (path: string) => Promise<boolean>
  read?: (path: string) => Promise<string>
  mkdir?: (path: string) => Promise<void>
  write?: (path: string, data: string) => Promise<void>
}): TaskChutePluginLike {
  const exists = options?.exists ?? jest.fn(async () => false)
  const read = options?.read ?? jest.fn(async () => '')
  const mkdir = options?.mkdir ?? jest.fn(async () => {})
  const write = options?.write ?? jest.fn(async () => {})

  const adapter = { exists, read, mkdir, write }

  const plugin = {
    app: {
      vault: {
        adapter,
        configDir: 'config',
      },
      metadataCache: {},
      fileManager: {},
    },
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
    },
    pathManager: {
      getProjectFolderPath: () => 'Projects',
    },
    routineAliasService: {},
    dayStateService: {},
    saveSettings: jest.fn(),
    _log: jest.fn(),
    _notify: jest.fn(),
    manifest: {
      id: 'taskchute-plus',
      dir: 'taskchute-plus',
    },
  }

  return plugin as unknown as TaskChutePluginLike
}

describe('ProjectBoardStateStore', () => {
  test('returns default state when file missing', async () => {
    const plugin = createPlugin({ exists: jest.fn(async () => false) })
    const store = new ProjectBoardStateStore(plugin)

    const state = await store.load()
    expect(state.hiddenStatuses).toEqual([])
  })

  test('load normalizes malformed contents', async () => {
    const plugin = createPlugin({
      exists: jest.fn(async () => true),
      read: jest.fn(async () => JSON.stringify({ hiddenStatuses: ['todo', 'invalid', 'done', 'done'] })),
    })

    const store = new ProjectBoardStateStore(plugin)
    const state = await store.load()
    expect(state.hiddenStatuses).toEqual(['todo', 'done'])
  })

  test('save writes filtered hidden statuses and ensures directory', async () => {
    const mkdir = jest.fn(async () => {})
    const exists = jest.fn(async (path: string) => path.endsWith('/data'))
    const write = jest.fn(async () => {})

    const plugin = createPlugin({ exists, mkdir, write })
    const store = new ProjectBoardStateStore(plugin)

    const invalidStatus = 'ignored' as unknown as ProjectBoardState extends { hiddenStatuses: (infer S)[] } ? S : never

    await store.save({ hiddenStatuses: ['todo', 'todo', 'in-progress', invalidStatus], updatedAt: '' })

    expect(mkdir).not.toHaveBeenCalled() // exists returned true for data dir
    expect(write).toHaveBeenCalled()
    const payload = JSON.parse(write.mock.calls[0][1])
    expect(payload.hiddenStatuses).toEqual(['todo', 'in-progress'])
    expect(typeof payload.updatedAt).toBe('string')
  })
})
