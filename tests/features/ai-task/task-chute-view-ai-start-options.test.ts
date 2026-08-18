/**
 * TaskChuteView.startAiRun option forwarding:
 *   - the run mode comes from settings.aiTaskRunMode (default terminal)
 *   - the originating instanceId is attached to the run
 *   - the PTY size comes from the pane controller's computeTerminalSize()
 *     and falls back to 120x30 when no pane is mounted
 *   - the pane opens on the started run
 */
import { TFile, WorkspaceLeaf } from 'obsidian'
import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
import type { AiRunStartOptions } from '../../../src/features/ai-task/services/AiTaskManager'
import type { TaskChutePluginLike, TaskInstance } from '../../../src/types'

const TASK_PATH = 'TASKS/ai-task.md'

interface ManagerStub {
  startRun: jest.Mock<Promise<AiRunRecord>, [TFile, AiRunStartOptions?]>
  stopRun: jest.Mock
  getRuns: jest.Mock
  getRun: jest.Mock
  getActiveRunForTask: jest.Mock
  requestStopForTask: jest.Mock
  onChange: jest.Mock
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): ManagerStub {
  return {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    requestStopForTask: jest.fn(),
    onChange: jest.fn(() => jest.fn()),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
}

function createPluginStub(
  settingsOverrides: Record<string, unknown> = {},
): TaskChutePluginLike {
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
        commands: {},
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
      aiTaskEnabled: true,
      ...settingsOverrides,
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
    dayStateService: {
      loadDay: jest.fn(async () => ({
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
      })),
      saveDay: jest.fn(async () => undefined),
      consumeLocalStateWrite: jest.fn(() => false),
    },
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

function makeTaskFile(path = TASK_PATH, basename = 'ai-task'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = basename
  file.extension = 'md'
  return file
}

function makeInstance(instanceId = 'inst-1'): TaskInstance {
  const file = makeTaskFile()
  return {
    task: {
      file,
      frontmatter: { ai_task: true },
      path: file.path,
      name: 'ai-task',
    },
    instanceId,
    state: 'idle',
    slotKey: 'none',
  } as TaskInstance
}

function makeRecord(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'ai-run-1',
    taskPath: TASK_PATH,
    taskName: 'ai-task',
    host: 'claude',
    mode: 'terminal',
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

interface ViewInternals {
  startAiRun(inst: TaskInstance): Promise<void>
  aiRunPaneController: unknown
}

function setUp(settingsOverrides: Record<string, unknown> = {}): {
  manager: ManagerStub
  view: TaskChuteView
  internals: ViewInternals
} {
  const plugin = createPluginStub(settingsOverrides)
  const manager = createManagerStub()
  ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  return { manager, view, internals: view as unknown as ViewInternals }
}

describe('TaskChuteView startAiRun option forwarding', () => {
  test('passes terminal mode, the originating instanceId, and the 120x30 fallback size', async () => {
    const { manager, internals } = setUp()
    manager.startRun.mockResolvedValueOnce(makeRecord({ instanceId: 'inst-7' }))

    await internals.startAiRun(makeInstance('inst-7'))

    expect(manager.startRun).toHaveBeenCalledTimes(1)
    const [file, options] = manager.startRun.mock.calls[0]
    expect(file.path).toBe(TASK_PATH)
    expect(options).toEqual({
      mode: 'terminal',
      instanceId: 'inst-7',
      cols: 120,
      rows: 30,
    })
  })

  test('passes headless mode when the setting says so', async () => {
    const { manager, internals } = setUp({ aiTaskRunMode: 'headless' })
    manager.startRun.mockResolvedValueOnce(makeRecord({ mode: 'headless' }))

    await internals.startAiRun(makeInstance())

    const options = manager.startRun.mock.calls[0][1]
    expect(options?.mode).toBe('headless')
  })

  test('uses the pane controller size when the pane is mounted', async () => {
    const { manager, view, internals } = setUp()
    const openRun = jest.fn()
    ;(view as unknown as { aiRunPaneController: unknown }).aiRunPaneController = {
      computeTerminalSize: () => ({ cols: 96, rows: 20 }),
      openRun,
    }
    manager.startRun.mockResolvedValueOnce(makeRecord())

    await internals.startAiRun(makeInstance())

    const options = manager.startRun.mock.calls[0][1]
    expect(options?.cols).toBe(96)
    expect(options?.rows).toBe(20)
    expect(openRun).toHaveBeenCalledWith('ai-run-1')
  })
})
