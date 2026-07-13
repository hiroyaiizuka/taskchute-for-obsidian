/**
 * Play/stop coupling between the human task timer and AI runs:
 *   - a successful human start of an ai_task instance also fires the AI run
 *   - a refused/failed human start (TaskExecutionService returns false and
 *     leaves the instance idle — e.g. the future-date guard) fires nothing
 *   - an already-active AI run is skipped silently (no duplicate, no Notice)
 *   - AI start failures notify but never block or roll back the human start
 *   - a human stop kills the active AI run for that task path; a no-op stop
 *     (instance not running, service returns false) leaves the AI run alone
 *   - reset-to-idle and deletion of a RUNNING instance also stop the AI run
 * The 🤖 row button keeps its "run AI only" semantics (not covered here).
 *
 * The execution stubs mirror the real TaskExecutionService contract: it never
 * rejects; it reports refusal/failure by returning false and leaving
 * inst.state untouched, and success by mutating inst.state and returning true.
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
  requestStopForTask: jest.Mock<void, [string]>
  onChange: jest.Mock<() => void, [(record: AiRunRecord) => void]>
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
}

function createManagerStub(): ManagerStub {
  const stub: ManagerStub = {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    followUp: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    requestStopForTask: jest.fn(),
    onChange: jest.fn(() => jest.fn()),
    invalidateBinaryCache: jest.fn(),
    dispose: jest.fn(),
  }
  // Real-contract mirror: stop the task's active run when one is registered.
  // (Queueing the stop during a pending start is AiTaskManager behavior,
  // covered by its own unit tests.)
  stub.requestStopForTask.mockImplementation((taskPath: string) => {
    const active = stub.getActiveRunForTask(taskPath) as AiRunRecord | undefined
    if (active) stub.stopRun(active.id)
  })
  return stub
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
  startInstance: jest.Mock<Promise<boolean>, [TaskInstance]>
  stopInstance: jest.Mock<Promise<boolean>, [TaskInstance, Date?]>
}

interface MutationStub {
  deleteTask: jest.Mock<Promise<void>, [TaskInstance]>
  deleteInstance: jest.Mock<Promise<void>, [TaskInstance]>
}

function createView(plugin: TaskChutePluginLike): {
  view: TaskChuteView
  execution: ExecutionStub
  mutation: MutationStub
} {
  const leaf = {
    containerEl: document.createElement('div'),
  } as unknown as WorkspaceLeaf
  const view = new TaskChuteView(leaf, plugin)
  view.containerEl = document.createElement('div')
  view.renderTaskList = jest.fn()
  // Real-contract stubs: success mutates inst.state and resolves true;
  // refusal/failure resolves false without touching the state. Never rejects.
  const execution: ExecutionStub = {
    startInstance: jest.fn(async (inst: TaskInstance) => {
      inst.state = 'running'
      return true
    }),
    stopInstance: jest.fn(async (inst: TaskInstance) => {
      if (inst.state !== 'running') return false
      inst.state = 'done'
      return true
    }),
  }
  ;(view as unknown as { taskExecutionService: ExecutionStub }).taskExecutionService =
    execution
  const mutation: MutationStub = {
    deleteTask: jest.fn(async () => undefined),
    deleteInstance: jest.fn(async () => undefined),
  }
  ;(view as unknown as { taskMutationService: MutationStub }).taskMutationService =
    mutation
  return { view, execution, mutation }
}

/**
 * Stub the view internals that TaskTimeController.resetTaskToIdle reaches
 * through its host closures, so the real controller can run in isolation.
 */
function stubResetInternals(view: TaskChuteView): void {
  const internals = view as unknown as Record<string, unknown>
  internals.saveRunningTasksState = jest.fn(async () => undefined)
  internals.removeTaskLogForInstanceOnCurrentDate = jest.fn(async () => undefined)
  internals.getInstanceDisplayTitle = jest.fn(() => 'ai-task')
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
    mode: 'headless',
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
  mutation: MutationStub
} {
  const plugin = createPluginStub()
  const manager = createManagerStub()
  ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
  const { view, execution, mutation } = createView(plugin)
  return { manager, view, execution, mutation }
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

  test('does not fire the AI run when the human start is refused (future-date guard)', async () => {
    const { manager, view, execution } = setUp()
    // Real contract: the service notices, returns false, and leaves the
    // instance idle. It never rejects.
    execution.startInstance.mockImplementationOnce(async () => false)
    const inst = makeInstance()

    await expect(view.startInstance(inst)).resolves.toBeUndefined()
    await flushPromises()

    expect(inst.state).toBe('idle')
    expect(manager.startRun).not.toHaveBeenCalled()
  })
})

describe('TaskChuteView stop button coupling', () => {
  function makeRunningInstance(): TaskInstance {
    const inst = makeInstance()
    inst.state = 'running'
    return inst
  }

  test('a human stop kills the active AI run for the task path', async () => {
    const { manager, view, execution } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-42' }))
    const inst = makeRunningInstance()

    await view.stopInstance(inst)

    expect(execution.stopInstance).toHaveBeenCalledWith(inst, undefined)
    expect(manager.getActiveRunForTask).toHaveBeenCalledWith(TASK_PATH)
    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-42')
  })

  test('a human stop without an active AI run leaves the manager alone', async () => {
    const { manager, view } = setUp()

    await view.stopInstance(makeRunningInstance())

    expect(manager.stopRun).not.toHaveBeenCalled()
  })

  test('a human stop works when the feature is disabled', async () => {
    const plugin = createPluginStub()
    const { view, execution } = createView(plugin)

    await expect(view.stopInstance(makeRunningInstance())).resolves.toBeUndefined()
    expect(execution.stopInstance).toHaveBeenCalledTimes(1)
  })

  test('a no-op human stop (instance not running) leaves the AI run alone', async () => {
    const { manager, view, execution } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord())
    // Real contract: stopping a non-running instance is a no-op that
    // resolves false. It never rejects.
    const inst = makeInstance()

    await expect(view.stopInstance(inst)).resolves.toBeUndefined()

    expect(execution.stopInstance).toHaveBeenCalledTimes(1)
    expect(inst.state).toBe('idle')
    expect(manager.stopRun).not.toHaveBeenCalled()
  })
})

describe('AI run tab close coupling back to TaskChute', () => {
  const requestTaskStop = (view: TaskChuteView, record: AiRunRecord): void => {
    ;(view as unknown as {
      handleAiRunStopAndClose(record: AiRunRecord): void
    }).handleAiRunStopAndClose(record)
  }

  test('stops the originating running instance by instanceId', async () => {
    const { view, execution } = setUp()
    const origin = makeInstance()
    origin.instanceId = 'origin-instance'
    origin.state = 'running'
    const sibling = makeInstance()
    sibling.instanceId = 'sibling-instance'
    sibling.state = 'running'
    view.taskInstances = [sibling, origin]

    requestTaskStop(
      view,
      makeRecord({ instanceId: 'origin-instance', taskPath: TASK_PATH }),
    )
    await flushPromises()

    expect(execution.stopInstance).toHaveBeenCalledWith(origin, undefined)
    expect(origin.state).toBe('done')
    expect(sibling.state).toBe('running')
  })

  test('falls back to the running task path when instanceId is stale', async () => {
    const { view, execution } = setUp()
    const inst = makeInstance()
    inst.instanceId = 'current-instance'
    inst.state = 'running'
    view.taskInstances = [inst]

    requestTaskStop(
      view,
      makeRecord({ instanceId: 'stale-instance', taskPath: TASK_PATH }),
    )
    await flushPromises()

    expect(execution.stopInstance).toHaveBeenCalledWith(inst, undefined)
  })

  test('does not stop an idle or unrelated task', async () => {
    const { view, execution } = setUp()
    const idle = makeInstance()
    idle.state = 'idle'
    view.taskInstances = [idle]

    requestTaskStop(view, makeRecord({ instanceId: idle.instanceId }))
    await flushPromises()

    expect(execution.stopInstance).not.toHaveBeenCalled()
  })
})

describe('TaskChuteView reset-to-idle coupling', () => {
  const asResetCapable = (view: TaskChuteView) =>
    view as unknown as { resetTaskToIdle(inst: TaskInstance): Promise<void> }

  test('resetting a running ai_task instance to idle stops the active AI run', async () => {
    const { manager, view } = setUp()
    stubResetInternals(view)
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-7' }))
    const inst = makeInstance()
    inst.state = 'running'

    await asResetCapable(view).resetTaskToIdle(inst)

    expect(inst.state).toBe('idle')
    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-7')
  })

  test('resetting a done instance leaves the AI run alone', async () => {
    const { manager, view } = setUp()
    stubResetInternals(view)
    manager.getActiveRunForTask.mockReturnValue(makeRecord())
    const inst = makeInstance()
    inst.state = 'done'

    await asResetCapable(view).resetTaskToIdle(inst)

    expect(manager.stopRun).not.toHaveBeenCalled()
  })
})

describe('TaskChuteView delete coupling', () => {
  const asDeleteCapable = (view: TaskChuteView) =>
    view as unknown as {
      deleteTask(inst: TaskInstance): Promise<void>
      deleteInstance(inst: TaskInstance): Promise<void>
    }

  test('deleting a running ai_task instance stops the active AI run', async () => {
    const { manager, view, mutation } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-9' }))
    const inst = makeInstance()
    inst.state = 'running'

    await asDeleteCapable(view).deleteTask(inst)

    expect(mutation.deleteTask).toHaveBeenCalledWith(inst)
    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-9')
  })

  test('deleting a running instance (single occurrence) stops the active AI run', async () => {
    const { manager, view, mutation } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-10' }))
    const inst = makeInstance()
    inst.state = 'running'

    await asDeleteCapable(view).deleteInstance(inst)

    expect(mutation.deleteInstance).toHaveBeenCalledWith(inst)
    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-10')
  })

  test('deleting an idle instance leaves the AI run alone', async () => {
    const { manager, view } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord())

    await asDeleteCapable(view).deleteTask(makeInstance())

    expect(manager.stopRun).not.toHaveBeenCalled()
  })
})

describe('TaskChuteView stop coupling during the AI start window', () => {
  test('a human stop routes through requestStopForTask even before the run registers', async () => {
    const { manager, view } = setUp()
    // Simulate the async AI-start window: startRun is still in flight, so no
    // active run is registered yet. The stop must reach the manager anyway
    // (it queues the stop for the moment the dispatch lands).
    manager.getActiveRunForTask.mockReturnValue(undefined)
    const inst = makeInstance()
    inst.state = 'running'

    await view.stopInstance(inst)

    expect(manager.requestStopForTask).toHaveBeenCalledWith(TASK_PATH)
  })

  test('resetting a running instance also routes through requestStopForTask', async () => {
    const { manager, view } = setUp()
    stubResetInternals(view)
    manager.getActiveRunForTask.mockReturnValue(undefined)
    const inst = makeInstance()
    inst.state = 'running'

    await (
      view as unknown as { resetTaskToIdle(inst: TaskInstance): Promise<void> }
    ).resetTaskToIdle(inst)

    expect(manager.requestStopForTask).toHaveBeenCalledWith(TASK_PATH)
  })
})

describe('TaskChuteView duplicated-instance stop coupling', () => {
  function makeRunningDuplicate(instanceId: string): TaskInstance {
    const inst = makeInstance()
    inst.instanceId = instanceId
    inst.state = 'running'
    return inst
  }

  test('stopping one of two running duplicates keeps the shared AI run alive', async () => {
    const { manager, view } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-dup' }))
    const instA = makeRunningDuplicate('inst-a')
    const instB = makeRunningDuplicate('inst-b')
    view.taskInstances = [instA, instB]

    await view.stopInstance(instB)

    expect(manager.requestStopForTask).not.toHaveBeenCalled()
    expect(manager.stopRun).not.toHaveBeenCalled()
  })

  test('stopping the last running duplicate stops the AI run', async () => {
    const { manager, view } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-dup' }))
    const instA = makeRunningDuplicate('inst-a')
    const instB = makeRunningDuplicate('inst-b')
    view.taskInstances = [instA, instB]

    await view.stopInstance(instB)
    expect(manager.stopRun).not.toHaveBeenCalled()

    await view.stopInstance(instA)

    expect(manager.stopRun).toHaveBeenCalledWith('ai-run-dup')
  })

  test('deleting a running duplicate while its sibling still runs keeps the AI run alive', async () => {
    const { manager, view } = setUp()
    manager.getActiveRunForTask.mockReturnValue(makeRecord({ id: 'ai-run-dup' }))
    const instA = makeRunningDuplicate('inst-a')
    const instB = makeRunningDuplicate('inst-b')
    view.taskInstances = [instA, instB]

    await (
      view as unknown as { deleteInstance(inst: TaskInstance): Promise<void> }
    ).deleteInstance(instB)

    expect(manager.requestStopForTask).not.toHaveBeenCalled()
    expect(manager.stopRun).not.toHaveBeenCalled()
  })
})
