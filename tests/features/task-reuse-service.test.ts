import { Notice, TFile } from 'obsidian'
import { TaskReuseService } from '../../src/features/core/services/TaskReuseService'
import type { TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  class MockTFile {
    path = ''
    basename = ''
    extension = 'md'
  }
  return {
    ...actual,
    Notice: jest.fn(),
    TFile: MockTFile,
  }
})

describe('TaskReuseService', () => {
  const NoticeMock = Notice as unknown as jest.Mock

  beforeEach(() => {
    NoticeMock.mockClear()
  })

  const createFile = (): TFile => {
    const file = new TFile()
    file.path = 'TaskChute/Task/sample.md'
    file.basename = 'sample'
    return file
  }

  const createPlugin = (): TaskChutePluginLike => {
    const file = createFile()
    const dayState = {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
    }

    const metadataCacheMock = {
      getFileCache: jest.fn().mockReturnValue({ frontmatter: { taskId: 'tc-task-sample' } }),
    }

    return {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
        },
        metadataCache: metadataCacheMock,
        fileManager: {
          processFrontMatter: jest.fn(),
          trashFile: jest.fn(),
        },
      } as unknown as TaskChutePluginLike['app'],
      dayStateService: {
        getDateFromKey: jest.fn().mockReturnValue(new Date('2025-11-07')),
        loadDay: jest.fn().mockResolvedValue(dayState),
        saveDay: jest.fn().mockResolvedValue(undefined),
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
        renameTaskPath: jest.fn(),
      } as unknown as TaskChutePluginLike['dayStateService'],
      routineAliasService: {} as TaskChutePluginLike['routineAliasService'],
      pathManager: {} as TaskChutePluginLike['pathManager'],
      settings: { slotKeys: {} },
      saveSettings: jest.fn(),
      _log: jest.fn(),
      _notify: jest.fn(),
      manifest: { id: 'taskchute-plus', name: 'TaskChute Plus', version: '1.0.0', minAppVersion: '1.4.0' },
    }
  }

  test('reuseTaskAtDate writes duplicate entry to day state without updating frontmatter', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    expect(dayState.duplicatedInstances).toHaveLength(1)
    expect(dayState.duplicatedInstances[0]).toMatchObject({
      originalPath: 'TaskChute/Task/sample.md',
      slotKey: 'none',
      originalTaskId: 'tc-task-sample',
    })
    expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
    expect(dateService.saveDay).toHaveBeenCalled()
    expect(NoticeMock).toHaveBeenCalled()
  })

  test('reuseTaskAtDate keeps hidden routine entry but still records duplicate', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))
    dayState.hiddenRoutines.push({
      path: 'TaskChute/Task/sample.md',
      instanceId: null,
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    expect(dayState.hiddenRoutines).toHaveLength(1)
    expect(dayState.hiddenRoutines[0]).toMatchObject({
      path: 'TaskChute/Task/sample.md',
      instanceId: null,
    })
    expect(dayState.duplicatedInstances).toHaveLength(1)
    expect(dateService.saveDay).toHaveBeenCalled()
  })
})
