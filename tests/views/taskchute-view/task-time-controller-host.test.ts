import { WorkspaceLeaf } from 'obsidian'
import type { TaskChutePluginLike } from '../../../src/types'
import TaskTimeController from '../../../src/ui/time/TaskTimeController'
import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView'

jest.mock('obsidian')
jest.mock('../../../src/ui/time/TaskTimeController', () => {
  const ctor = jest.fn()
  return {
    __esModule: true,
    default: ctor,
  }
})

function createPluginStub(): TaskChutePluginLike {
  const dayStateService = {
    loadDay: jest.fn(async () => ({
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    })),
    saveDay: jest.fn(async () => undefined),
    consumeLocalStateWrite: jest.fn(() => false),
  }

  return {
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
        getFiles: jest.fn(() => []),
        read: jest.fn(async () => ''),
        modify: jest.fn(),
        create: jest.fn(),
        on: jest.fn(() => ({ detach: jest.fn() })),
        adapter: {
          stat: jest.fn(async () => ({ ctime: Date.now(), mtime: Date.now() })),
          exists: jest.fn(async () => false),
          read: jest.fn(async () => '{}'),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
      setting: {
        open: jest.fn(),
        openTabById: jest.fn(),
      },
      commands: {
        commands: { 'terminal:open-terminal.integrated.root': {} },
        executeCommandById: jest.fn(),
      },
    },
    settings: {
      slotKeys: {},
      useOrderBasedSort: true,
      taskFolderPath: 'TASKS',
      projectFolderPath: 'PROJECTS',
      logDataPath: 'LOGS',
      reviewDataPath: 'REVIEWS',
      aiRobotButtonEnabled: false,
    },
    saveSettings: jest.fn(),
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn(),
      getLogYearPath: (year: string | number) => `${year}`,
      ensureYearFolder: jest.fn(async (year: string | number) => `${year}`),
      validatePath: () => ({ valid: true }),
    },
    dayStateService,
    routineAliasService: {
      getRouteNameFromAlias: jest.fn((name: string) => name),
      loadAliases: jest.fn().mockResolvedValue({}),
    },
    manifest: {
      id: 'taskchute-plus',
    },
    _notify: jest.fn(),
  } as unknown as TaskChutePluginLike
}

describe('TaskChuteView task time controller host', () => {
  beforeEach(() => {
    ;(TaskTimeController as jest.Mock).mockClear()
  })

  test('passes confirmStopNextDay to TaskTimeController host', () => {
    const plugin = createPluginStub()
    const leaf = {
      containerEl: document.createElement('div'),
    } as unknown as WorkspaceLeaf

    const view = new TaskChuteView(leaf, plugin)
    view.containerEl = document.createElement('div')

    const calls = (TaskTimeController as jest.Mock).mock.calls
    expect(calls).toHaveLength(1)
    const host = calls[0][0] as { confirmStopNextDay?: unknown }
    expect(host.confirmStopNextDay).toBeInstanceOf(Function)
  })
})
