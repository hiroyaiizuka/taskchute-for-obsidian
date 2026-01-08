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

  // NOTE: このテストは以前のバグ動作をテストしていた
  // 修正後は、パスレベルのhiddenRoutinesは再利用時にクリアされる
  // 詳細は 'clears path-level hidden entry for the same path' テストを参照
  test('reuseTaskAtDate clears path-level hidden and records duplicate', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))
    dayState.hiddenRoutines.push({
      path: 'TaskChute/Task/sample.md',
      instanceId: null,
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // 修正後: パスレベルのhiddenはクリアされる
    expect(dayState.hiddenRoutines).toHaveLength(0)
    expect(dayState.duplicatedInstances).toHaveLength(1)
    expect(dateService.saveDay).toHaveBeenCalled()
  })

  // === バグ修正テスト: 削除→再利用後の状態復元 ===

  test('reuseTaskAtDate clears path-level hidden entry for the same path', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))

    // パスレベルのhidden（instanceId: null）を追加
    dayState.hiddenRoutines.push({
      path: 'TaskChute/Task/sample.md',
      instanceId: null,
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // パスレベルのhiddenはクリアされるべき
    const pathLevelHidden = dayState.hiddenRoutines.filter(
      (entry) => typeof entry === 'object' && entry.path === 'TaskChute/Task/sample.md' && !entry.instanceId
    )
    expect(pathLevelHidden).toHaveLength(0)
    expect(dayState.duplicatedInstances).toHaveLength(1)
    expect(dateService.saveDay).toHaveBeenCalled()
  })

  test('reuseTaskAtDate preserves instance-specific hidden entry', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))

    // インスタンス固有のhidden（instanceId あり）を追加
    dayState.hiddenRoutines.push({
      path: 'TaskChute/Task/sample.md',
      instanceId: 'specific-instance-123',
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // インスタンス固有のhiddenは残るべき
    expect(dayState.hiddenRoutines).toHaveLength(1)
    expect(dayState.hiddenRoutines[0]).toMatchObject({
      path: 'TaskChute/Task/sample.md',
      instanceId: 'specific-instance-123',
    })
    expect(dayState.duplicatedInstances).toHaveLength(1)
  })

  test('reuseTaskAtDate clears temporary deleted entry for the same path', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))

    // temporary削除エントリを追加
    dayState.deletedInstances.push({
      path: 'TaskChute/Task/sample.md',
      instanceId: 'old-instance',
      deletionType: 'temporary',
      timestamp: Date.now(),
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // temporary削除エントリはクリアされるべき
    const temporaryDeleted = dayState.deletedInstances.filter(
      (entry) => entry.path === 'TaskChute/Task/sample.md' && entry.deletionType === 'temporary'
    )
    expect(temporaryDeleted).toHaveLength(0)
    expect(dayState.duplicatedInstances).toHaveLength(1)
  })

  test('reuseTaskAtDate preserves hidden entries for different paths', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))

    // 別パスのhiddenを追加
    dayState.hiddenRoutines.push({
      path: 'TaskChute/Task/other.md',
      instanceId: null,
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // 別パスのhiddenは残るべき
    expect(dayState.hiddenRoutines).toHaveLength(1)
    expect(dayState.hiddenRoutines[0]).toMatchObject({
      path: 'TaskChute/Task/other.md',
      instanceId: null,
    })
    expect(dayState.duplicatedInstances).toHaveLength(1)
  })

  test('reuseTaskAtDate preserves permanent deleted entry', async () => {
    const plugin = createPlugin()
    const dateService = plugin.dayStateService
    const dayState = await dateService.loadDay(plugin.dayStateService.getDateFromKey('2025-11-07'))

    // permanent削除エントリを追加（非ルーチンタスクの完全削除など）
    dayState.deletedInstances.push({
      path: 'TaskChute/Task/sample.md',
      deletionType: 'permanent',
      timestamp: Date.now(),
    })
    const service = new TaskReuseService(plugin)

    await service.reuseTaskAtDate('TaskChute/Task/sample.md', '2025-11-07')

    // permanent削除エントリは残るべき（ただし、この動作は議論の余地あり）
    expect(dayState.deletedInstances).toHaveLength(1)
    expect(dayState.deletedInstances[0]).toMatchObject({
      deletionType: 'permanent',
    })
    expect(dayState.duplicatedInstances).toHaveLength(1)
  })
})
