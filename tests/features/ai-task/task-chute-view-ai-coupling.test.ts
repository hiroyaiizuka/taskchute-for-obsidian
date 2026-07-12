/**
 * Play/stop coupling between the human task timer and AI runs:
 *   - a successful human start of an ai_task instance also fires the AI run
 *   - an already-active AI run is skipped silently (no duplicate, no Notice)
 *   - AI start failures notify but never block or roll back the human start
 *   - a human stop kills the active AI run for that task path
 * The 🤖 row button keeps its "run AI only" semantics (not covered here).
 */
import { Notice, TFile, WorkspaceLeaf } from 'obsidian'
import { TaskChuteView } from '../../../src/features/core/views/TaskChuteView'
import { AiRunAlreadyActiveError } from '../../../src/features/ai-task/services/AiTaskManager'
import { AiBinaryNotFoundError } from '../../../src/features/ai-task/services/BinaryLocator'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
import type { TaskChutePluginLike, TaskInstance } from '../../../src/types'

const TASK_PATH = 'TASKS/ai-task.md'

interface ManagerStub {
  startRun: jest.Mock<Promise<AiRunRecord>, [TFile]>
  stopRun: jest.Mock
  followUp: jest.Mock
  getRuns: jest.Mock
  getRun: jest.Mock
  getActiveRunForTask: jest.Mock
  onChange: jest.Mock<() => void, [(record: AiRunRecord) => void]>
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): ManagerStub {
  return {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    followUp: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    onChange: jest.fn(() => jest.fn()),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
}

function createPluginStub(): TaskChutePluginLike {
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

interface ExecutionStub {
  startInstance: jest.Mock<Promise<void>, [TaskInstance]>
  stopInstance: jest.Mock<Promise<void>, [TaskInstance, Date?]>
}

function createView(plugin: TaskChutePluginLike): {
  view: TaskChuteView
  execution: ExecutionStub
} {
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  const execution: ExecutionStub = {
    startInstance: jest.fn(async () => undefined),
    stopInstance: jest.fn(async () => undefined),
  }
  ;(view as unknown as { taskExecutionService: ExecutionStub }).taskExecutionService =
    execution
  return { view, execution }
}

function makeTaskFile(path = TASK_PATH, basename = 'ai-task'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = basename
  file.extension = 'md'
  return file
}

function makeInstance(
  frontmatter: Record<string, unknown> = { ai_task: true },
  file: TFile | null = makeTaskFile(),
): TaskInstance {
  return {
    task: {
      file,
      frontmatter,
      path: file?.path ?? TASK_PATH,
      name: 'ai-task',
    },
    instanceId: 'inst-1',
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
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function noticeMessages(): string[] {
  return (Notice as unknown as jest.Mock).mock.calls.map((call) => String(call[0]))
}

function setUp(): {
  manager: ManagerStub
  view: TaskChuteView
  execution: ExecutionStub
} {
  const plugin = createPluginStub()
  const manager = createManagerStub()
  ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
  const { view, execution } = createView(plugin)
  return { manager, view, execution }
}

beforeEach(() => {
  ;(Notice as unknown as jest.Mock).mockClear()
})

describe('TaskChuteView play button coupling', () => {
  test('a human start of an ai_task instance also fires the AI run', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockResolvedValueOnce(makeRecord())
    const inst = makeInstance()

    await view.startInstance(inst)
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledWith(inst)
    expect(manager.startRun).toHaveBeenCalledTimes(1)
    expect(manager.startRun.mock.calls[0][0].path).toBe(TASK_PATH)
    expect(noticeMessages()).toEqual([])
  })

  test('skips silently when an AI run is already active for the task', async () => {
    const { manager, view, execution } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord())

    await view.startInstance(makeInstance())
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(manager.startRun).not.toHaveBeenCalled()
    expect(noticeMessages()).toEqual([])
  })

  test('swallows an already-active race from startRun without a Notice', async () => {
    const { manager, view } = setUp()
    manager.startRun.mockRejectedValueOnce(new AiRunAlreadyActiveError(TASK_PATH))

    await view.startInstance(makeInstance())
    await flushPromises()

    expect(manager.startRun).toHaveBeenCalledTimes(1)
    expect(noticeMessages()).toEqual([])
  })

  test('an AI start failure notifies but does not block the human start', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockRejectedValueOnce(new AiBinaryNotFoundError('claude'))

    await expect(view.startInstance(makeInstance())).resolves.toBeUndefined()
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    const messages = noticeMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('was not found')
  })

  test('does not fire an AI run for tasks without ai_task config', async () => {
    const { manager, view, execution } = setUp()

    await view.startInstance(makeInstance({}))
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test('does nothing extra when the AI task feature is disabled', async () => {
    const plugin = createPluginStub()
    const { view, execution } = createView(plugin)

    await expect(view.startInstance(makeInstance())).resolves.toBeUndefined()
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(noticeMessages()).toEqual([])
  })

  test('does not fire the AI run when the human start itself fails', async () => {
    const { manager, view, execution } = setUp()
    execution.startInstance.mockRejectedValueOnce(new Error('start broke'))

    await expect(view.startInstance(makeInstance())).rejects.toThrow('start broke')
    await flushPromises()

    expect(manager.startRun).not.toHaveBeenCalled()
  })
})

describe('TaskChuteView stop button coupling', () => {
  test('a human stop kills the active AI run for the task path', async () => {
    const { manager, view, execution } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-42' }))
    const inst = makeInstance()

    await view.stopInstance(inst)

    expect(execution.stopInstance).toHaveBeenCalledWith(inst, undefined)
    expect(manager.getActiveRunForTask).toHaveBeenCalledWith(TASK_PATH)
    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-42')
  })

  test('a human stop without an active AI run leaves the manager alone', async () => {
    const { manager, view } = setUp()

    await view.stopInstance(makeInstance())

    expect(manager.stopRun).not.toHaveBeenCalled()
  })

  test('a human stop works when the feature is disabled', async () => {
    const plugin = createPluginStub()
    const { view, execution } = createView(plugin)

    await expect(view.stopInstance(makeInstance())).resolves.toBeUndefined()
    expect(execution.stopInstance).toHaveBeenCalledTimes(1)
  })

  test('does not stop the AI run when the human stop itself fails', async () => {
    const { manager, view, execution } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord())
    execution.stopInstance.mockRejectedValueOnce(new Error('stop broke'))

    await expect(view.stopInstance(makeInstance())).rejects.toThrow('stop broke')

    expect(manager.stopRun).not.toHaveBeenCalled()
  })
})
