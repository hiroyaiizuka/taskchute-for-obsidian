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
import {
  TaskChuteView,
  type AmbientAiTaskStartedRun,
} from '../../../src/features/core/views/TaskChuteView'
import {
  AiRunAlreadyActiveError,
  type PreparedAiRun,
} from '../../../src/features/ai-task/services/AiTaskManager'
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
  hasTaskRunLifecycle: jest.Mock<
    boolean,
    [string, { instanceId?: string; timerStartedAt?: number }?]
  >
  claimOrphanedTaskStateReconciliation: jest.Mock<
    boolean,
    [string, { instanceId?: string; timerStartedAt?: number }?]
  >
  releaseOrphanedTaskStateReconciliation: jest.Mock<void, [string, string?]>
  claimInterruptedTaskStateReconciliation: jest.Mock<boolean, [string]>
  completeInterruptedTaskStateReconciliation: jest.Mock<void, [string]>
  retryInterruptedTaskStateReconciliation: jest.Mock<void, [string]>
  coordinateInterruptedTaskStateReconciliation: jest.Mock<
    Promise<boolean>,
    [
      string,
      { instanceId?: string; timerStartedAt?: number },
      () => Promise<void>,
    ]
  >
  coordinateOrphanedTaskStateReconciliation: jest.Mock<
    Promise<boolean>,
    [
      string,
      { instanceId?: string; timerStartedAt?: number } | undefined,
      () => Promise<void>,
    ]
  >
  requestStopForTask: jest.Mock<void, [string]>
  onChange: jest.Mock<() => void, [(record: AiRunRecord) => void]>
  invalidateBinaryCache: jest.Mock
  dispose: jest.Mock
  prepareRun?: jest.Mock<Promise<PreparedAiRun>, [TFile, { mode?: string }?]>
  startPreparedRun?: jest.Mock<Promise<AiRunRecord>, [PreparedAiRun, unknown?]>
}

function makePreparedRun(path = TASK_PATH): PreparedAiRun {
  return {
    taskPath: path,
    taskName: path.split('/').pop()?.replace(/\.md$/u, '') ?? 'ai-task',
    host: 'claude',
    mode: 'headless',
    prompt: 'prepared',
    cwd: '/vault',
    extraArgs: [],
    binaryPath: '/bin/claude',
    recipeSnapshot: null,
  }
}

function createManagerStub(): ManagerStub {
  const stub: ManagerStub = {
    startRun: jest.fn(),
    stopRun: jest.fn(),
    followUp: jest.fn(),
    getRuns: jest.fn(() => []),
    getRun: jest.fn(() => undefined),
    getActiveRunForTask: jest.fn(() => undefined),
    hasTaskRunLifecycle: jest.fn(() => false),
    claimOrphanedTaskStateReconciliation: jest.fn(() => true),
    releaseOrphanedTaskStateReconciliation: jest.fn(),
    claimInterruptedTaskStateReconciliation: jest.fn(() => false),
    completeInterruptedTaskStateReconciliation: jest.fn(),
    retryInterruptedTaskStateReconciliation: jest.fn(),
    coordinateInterruptedTaskStateReconciliation: jest.fn(),
    coordinateOrphanedTaskStateReconciliation: jest.fn(),
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
  stub.claimOrphanedTaskStateReconciliation.mockImplementation(
    (taskPath, owner) => !stub.hasTaskRunLifecycle(taskPath, owner),
  )
  stub.coordinateInterruptedTaskStateReconciliation.mockImplementation(
    async (runId, _generation, repair) => {
      if (!stub.claimInterruptedTaskStateReconciliation(runId)) return false
      try {
        await repair()
        stub.completeInterruptedTaskStateReconciliation(runId)
        return true
      } catch (error) {
        stub.retryInterruptedTaskStateReconciliation(runId)
        throw error
      }
    },
  )
  stub.coordinateOrphanedTaskStateReconciliation.mockImplementation(
    async (taskPath, owner, repair) => {
      if (!stub.claimOrphanedTaskStateReconciliation(taskPath, owner)) return false
      try {
        await repair()
        return true
      } finally {
        stub.releaseOrphanedTaskStateReconciliation(taskPath, owner?.instanceId)
      }
    },
  )
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
  deleteTask: jest.Mock<Promise<boolean>, [TaskInstance]>
  deleteInstance: jest.Mock<Promise<boolean>, [TaskInstance]>
  rollbackDuplicateInstance: jest.Mock<Promise<void>, [TaskInstance]>
  duplicateInstance: jest.Mock<
    Promise<TaskInstance | void>,
    [TaskInstance, { returnInstance?: boolean; slotKey?: string }?]
  >
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
    deleteTask: jest.fn(async () => true),
    deleteInstance: jest.fn(async () => true),
    rollbackDuplicateInstance: jest.fn(async () => undefined),
    duplicateInstance: jest.fn(async () => undefined),
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

function makeHumanInstance(title: string, instanceId = 'human-1'): TaskInstance {
  const file = makeTaskFile(`TASKS/${title}.md`, title)
  return {
    task: {
      file,
      frontmatter: {},
      path: file.path,
      name: title,
      displayTitle: title,
    },
    instanceId,
    state: 'idle',
    slotKey: 'none',
  } as TaskInstance
}

function makeLinkedAiInstance(
  taskTitle: string,
  matchType: 'exact' | 'contains' = 'exact',
): TaskInstance {
  const inst = makeInstance(
    {
      ai_task: true,
      isRoutine: true,
      routine_enabled: true,
      obsidian_sync: { enabled: true, taskTitle, matchType },
    },
    makeTaskFile('TASKS/linked-ai.md', 'linked-ai'),
  )
  inst.instanceId = 'linked-ai-1'
  inst.task.isRoutine = true
  inst.task.displayTitle = 'Linked AI'
  return inst
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
  test('recipe preflight failure leaves the task idle and never starts its timer', async () => {
    const { manager, view, execution } = setUp()
    manager.prepareRun = jest.fn().mockRejectedValueOnce(
      new Error('Recipe could not be loaded'),
    )
    manager.startPreparedRun = jest.fn()
    const inst = makeInstance({
      ai_task: true,
      recipe: '[[TaskChute/Recipes/Missing]]',
    })

    await view.startInstance(inst)

    expect(manager.prepareRun).toHaveBeenCalledTimes(1)
    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startPreparedRun).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
  })

  test('prepared dispatch failure rolls the already-started timer back to idle', async () => {
    const { manager, view, execution } = setUp()
    manager.prepareRun = jest.fn().mockResolvedValueOnce(makePreparedRun())
    manager.startPreparedRun = jest.fn().mockRejectedValueOnce(
      new Error('spawn failed'),
    )
    ;(
      view as unknown as {
        removeRunningTaskRecord: jest.Mock
        saveRunningTasksState: jest.Mock
      }
    ).removeRunningTaskRecord = jest.fn(async () => undefined)
    ;(
      view as unknown as { saveRunningTasksState: jest.Mock }
    ).saveRunningTasksState = jest.fn(async () => undefined)
    const inst = makeInstance({
      ai_task: true,
      recipe: '[[TaskChute/Recipes/Publish]]',
    })

    await view.startInstance(inst)

    expect(execution.startInstance).toHaveBeenCalledWith(inst)
    expect(manager.startPreparedRun).toHaveBeenCalledTimes(1)
    expect(inst.state).toBe('idle')
    expect(
      (view as unknown as { removeRunningTaskRecord: jest.Mock })
        .removeRunningTaskRecord,
    ).toHaveBeenCalledWith(expect.objectContaining({ taskPath: TASK_PATH }))
  })

  test('stops the old run and rolls the timer back when the manager changes after manual dispatch', async () => {
    const { manager, view } = setUp()
    const plugin = (view as unknown as { plugin: TaskChutePluginLike }).plugin
    manager.prepareRun = jest.fn().mockResolvedValueOnce(makePreparedRun())
    manager.startPreparedRun = jest.fn().mockImplementationOnce(async () => {
      plugin.aiTaskManager = createManagerStub() as unknown as typeof plugin.aiTaskManager
      return makeRecord()
    })
    ;(
      view as unknown as {
        removeRunningTaskRecord: jest.Mock
        saveRunningTasksState: jest.Mock
      }
    ).removeRunningTaskRecord = jest.fn(async () => undefined)
    ;(
      view as unknown as { saveRunningTasksState: jest.Mock }
    ).saveRunningTasksState = jest.fn(async () => undefined)
    const inst = makeInstance()

    await view.startInstance(inst)

    expect(manager.startPreparedRun).toHaveBeenCalledTimes(1)
    expect(manager.requestStopForTask).toHaveBeenCalledWith(TASK_PATH)
    expect(inst.state).toBe('idle')
  })

  test('a stop during preflight invalidates the pending start before its timer begins', async () => {
    const { manager, view, execution } = setUp()
    let resolvePreflight!: (prepared: PreparedAiRun) => void
    manager.prepareRun = jest.fn(() => new Promise((resolve) => {
      resolvePreflight = resolve
    }))
    manager.startPreparedRun = jest.fn()
    const inst = makeInstance()

    const startPromise = view.startInstance(inst)
    await flushPromises()
    await view.stopInstance(inst)
    resolvePreflight(makePreparedRun())
    await startPromise

    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startPreparedRun).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
  })

  test('a stop that wins the prepared-dispatch edge stops the late run and keeps the task done', async () => {
    const { manager, view } = setUp()
    let resolveDispatch!: (record: AiRunRecord) => void
    manager.prepareRun = jest.fn().mockResolvedValueOnce(makePreparedRun())
    manager.startPreparedRun = jest.fn(() => new Promise((resolve) => {
      resolveDispatch = resolve
    }))
    const inst = makeInstance()

    const startPromise = view.startInstance(inst)
    await flushPromises()
    expect(inst.state).toBe('running')
    await view.stopInstance(inst)
    resolveDispatch(makeRecord())
    await startPromise

    expect(manager.requestStopForTask).toHaveBeenCalledWith(TASK_PATH)
    expect(inst.state).toBe('done')
  })

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

describe('TaskChuteView Obsidian-linked AI routine coupling', () => {
  test('linked recipe preflight failure never starts or owns the target', async () => {
    const { manager, view, execution, mutation } = setUp()
    manager.prepareRun = jest.fn().mockRejectedValueOnce(
      new Error('Recipe markers are corrupt'),
    )
    manager.startPreparedRun = jest.fn()
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    target.task.frontmatter.recipe = '[[TaskChute/Recipes/Corrupt]]'
    view.taskInstances = [source, target]

    await view.startInstance(source)

    expect(source.state).toBe('running')
    expect(target.state).toBe('idle')
    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(execution.startInstance).toHaveBeenCalledWith(source)
    expect(mutation.duplicateInstance).not.toHaveBeenCalled()
    expect(manager.startPreparedRun).not.toHaveBeenCalled()
  })

  test('does not change the linked target when the AI manager is unavailable', async () => {
    const plugin = createPluginStub()
    const { view, execution, mutation } = createView(plugin)
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    view.taskInstances = [source, target]

    await view.startInstance(source)
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(execution.startInstance).toHaveBeenCalledWith(source)
    expect(source.state).toBe('running')
    expect(target.state).toBe('idle')
    expect(mutation.duplicateInstance).not.toHaveBeenCalled()
  })

  test('starting a matching human task starts the first linked AI routine and its run', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockResolvedValueOnce(
      makeRecord({ taskPath: 'TASKS/linked-ai.md', instanceId: 'linked-ai-1' }),
    )
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    view.taskInstances = [source, target]

    await view.startInstance(source)
    await flushPromises()

    expect(execution.startInstance.mock.calls.map(([inst]) => inst)).toEqual([
      source,
      target,
    ])
    expect(source.state).toBe('running')
    expect(target.state).toBe('running')
    expect(manager.startRun).toHaveBeenCalledTimes(1)
    expect(manager.startRun.mock.calls[0][0].path).toBe('TASKS/linked-ai.md')
  })

  test('duplicates a completed linked target and owns the new running instance', async () => {
    const { manager, view, execution, mutation } = setUp()
    manager.startRun.mockResolvedValueOnce(
      makeRecord({ taskPath: 'TASKS/linked-ai.md', instanceId: 'linked-ai-2' }),
    )
    const source = makeHumanInstance('CEO review')
    const completed = makeLinkedAiInstance('CEO review')
    completed.state = 'done'
    const duplicate = {
      ...completed,
      instanceId: 'linked-ai-2',
      state: 'idle',
      isDuplicate: true,
    } as TaskInstance
    mutation.duplicateInstance.mockImplementationOnce(async () => {
      view.taskInstances.push(duplicate)
      return duplicate
    })
    view.taskInstances = [source, completed]

    await view.startInstance(source)
    await flushPromises()

    expect(mutation.duplicateInstance).toHaveBeenCalledWith(
      completed,
      expect.objectContaining({ returnInstance: true }),
    )
    expect(execution.startInstance.mock.calls.map(([inst]) => inst)).toEqual([
      source,
      duplicate,
    ])
    expect(completed.state).toBe('done')
    expect(duplicate.state).toBe('running')

    manager.getActiveRunForTask.mockReturnValue(
      makeRecord({ id: 'linked-run', taskPath: 'TASKS/linked-ai.md' }),
    )
    await view.stopInstance(source)

    expect(execution.stopInstance).toHaveBeenCalledWith(duplicate, undefined)
    expect(execution.stopInstance).not.toHaveBeenCalledWith(completed, undefined)
  })

  test('materializes a non-due linked candidate without exposing the template instance', async () => {
    const { manager, view, execution, mutation } = setUp()
    manager.startRun.mockResolvedValueOnce(
      makeRecord({ taskPath: 'TASKS/linked-ai.md', instanceId: 'linked-ai-2' }),
    )
    const source = makeHumanInstance('CEO review')
    const candidate = makeLinkedAiInstance('CEO review')
    const duplicate = {
      ...candidate,
      instanceId: 'linked-ai-2',
      state: 'idle',
      isDuplicate: true,
    } as TaskInstance
    mutation.duplicateInstance.mockImplementationOnce(async () => {
      view.taskInstances.push(duplicate)
      return duplicate
    })
    view.taskInstances = [source]
    view.linkedAiTaskCandidates = [candidate]

    await view.startInstance(source)
    await flushPromises()

    expect(mutation.duplicateInstance).toHaveBeenCalledWith(
      candidate,
      expect.objectContaining({
        returnInstance: true,
        suppressNotice: true,
      }),
    )
    expect(execution.startInstance.mock.calls.map(([inst]) => inst)).toEqual([
      source,
      duplicate,
    ])
    expect(candidate.state).toBe('idle')
    expect(view.taskInstances).toEqual([source, duplicate])
  })

  test('rolls back a materialized non-due candidate when its timer start fails', async () => {
    const { manager, view, execution, mutation } = setUp()
    const source = makeHumanInstance('CEO review')
    const candidate = makeLinkedAiInstance('CEO review')
    const duplicate = {
      ...candidate,
      instanceId: 'linked-ai-failed-start',
      state: 'idle',
      isDuplicate: true,
    } as TaskInstance
    mutation.duplicateInstance.mockImplementationOnce(async () => {
      view.taskInstances.push(duplicate)
      view.tasks.push(duplicate.task)
      return duplicate
    })
    mutation.rollbackDuplicateInstance.mockImplementationOnce(async (inst) => {
      view.taskInstances = view.taskInstances.filter((item) => item !== inst)
      view.tasks = view.tasks.filter((task) => task !== inst.task)
    })
    execution.startInstance
      .mockImplementationOnce(async (inst) => {
        inst.state = 'running'
        return true
      })
      .mockImplementationOnce(async () => false)
    view.taskInstances = [source]
    view.linkedAiTaskCandidates = [candidate]

    await view.startInstance(source)
    await flushPromises()

    expect(mutation.rollbackDuplicateInstance).toHaveBeenCalledWith(duplicate)
    expect(view.taskInstances).toEqual([source])
    expect(view.tasks).toEqual([])
    expect(candidate.state).toBe('idle')
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test('rolls back the linked timer when the AI manager is disabled during dispatch', async () => {
    const { manager, view, execution } = setUp()
    const plugin = (
      view as unknown as { plugin: TaskChutePluginLike }
    ).plugin
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    view.taskInstances = [source, target]
    ;(
      view as unknown as {
        removeRunningTaskRecord: () => Promise<void>
        saveRunningTasksState: () => Promise<void>
      }
    ).removeRunningTaskRecord = jest.fn(async () => undefined)
    ;(
      view as unknown as {
        saveRunningTasksState: () => Promise<void>
      }
    ).saveRunningTasksState = jest.fn(async () => undefined)
    execution.startInstance.mockImplementation(async (inst) => {
      inst.state = 'running'
      if (inst === target) {
        plugin.aiTaskManager = undefined
      }
      return true
    })

    await view.startInstance(source)
    await flushPromises()

    expect(target.state).toBe('idle')
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test('stops the old linked run and rolls back when the manager changes after dispatch', async () => {
    const { manager, view, mutation } = setUp()
    const plugin = (view as unknown as { plugin: TaskChutePluginLike }).plugin
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    target.state = 'done'
    const duplicate = {
      ...target,
      instanceId: 'linked-ai-replaced-manager',
      state: 'idle',
      isDuplicate: true,
    } as TaskInstance
    mutation.duplicateInstance.mockImplementationOnce(async () => {
      view.taskInstances.push(duplicate)
      return duplicate
    })
    view.taskInstances = [source, target]
    manager.prepareRun = jest.fn().mockResolvedValueOnce(
      makePreparedRun('TASKS/linked-ai.md'),
    )
    manager.startPreparedRun = jest.fn().mockImplementationOnce(async () => {
      plugin.aiTaskManager = createManagerStub() as unknown as typeof plugin.aiTaskManager
      return makeRecord({ taskPath: 'TASKS/linked-ai.md' })
    })
    ;(
      view as unknown as {
        removeRunningTaskRecord: jest.Mock
        saveRunningTasksState: jest.Mock
      }
    ).removeRunningTaskRecord = jest.fn(async () => undefined)
    ;(
      view as unknown as { saveRunningTasksState: jest.Mock }
    ).saveRunningTasksState = jest.fn(async () => undefined)

    await view.startInstance(source)

    expect(manager.startPreparedRun).toHaveBeenCalledTimes(1)
    expect(manager.requestStopForTask).toHaveBeenCalledWith('TASKS/linked-ai.md')
    expect(mutation.rollbackDuplicateInstance).toHaveBeenCalledWith(duplicate)
    expect(duplicate.state).toBe('idle')
    expect(target.state).toBe('done')
  })

  test('stopping the source task stops the AI instance and its terminal run', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockResolvedValueOnce(
      makeRecord({ taskPath: 'TASKS/linked-ai.md', instanceId: 'linked-ai-1' }),
    )
    const source = makeHumanInstance('Daily CEO review')
    const target = makeLinkedAiInstance('CEO review', 'contains')
    view.taskInstances = [source, target]

    await view.startInstance(source)
    await flushPromises()
    manager.getActiveRunForTask.mockReturnValue(
      makeRecord({ id: 'linked-run', taskPath: 'TASKS/linked-ai.md' }),
    )

    await view.stopInstance(source)

    expect(execution.stopInstance).toHaveBeenCalledWith(source, undefined)
    expect(execution.stopInstance).toHaveBeenCalledWith(target, undefined)
    expect(target.state).toBe('done')
    expect(manager.requestStopForTask).toHaveBeenCalledWith(
      'TASKS/linked-ai.md',
    )
    expect(manager.stopRun).toHaveBeenCalledWith('linked-run')
  })

  test('does not recursively launch a linked routine when an AI task starts', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockResolvedValue(makeRecord())
    const source = makeLinkedAiInstance('CEO review')
    const otherTarget = makeLinkedAiInstance('Linked AI')
    otherTarget.instanceId = 'linked-ai-2'
    otherTarget.task.path = 'TASKS/linked-ai-2.md'
    view.taskInstances = [source, otherTarget]

    await view.startInstance(source)
    await flushPromises()

    expect(execution.startInstance).toHaveBeenCalledTimes(1)
    expect(otherTarget.state).toBe('idle')
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

describe('interrupted AI run timer reconciliation', () => {
  const reconcile = async (view: TaskChuteView): Promise<void> => {
    await (view as unknown as {
      reconcileInterruptedAiRunTasks(): Promise<void>
    }).reconcileInterruptedAiRunTasks()
  }

  const stubInterruptedCleanup = (view: TaskChuteView) => {
    const runningTasksDelete = jest
      .spyOn(view.runningTasksService, 'deleteByInstanceOrPathStrict')
      .mockResolvedValue(1)
    const removeTaskLogForInstanceOnDate = jest
      .spyOn(view, 'removeTaskLogForInstanceOnDate')
      .mockResolvedValue(undefined)
    return {
      runningTasksDelete,
      removeTaskLogForInstanceOnDate,
    }
  }

  test('silently resets a restored timer to idle and only then completes the marker', async () => {
    const { manager, view, execution } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const record = makeRecord({ status: 'interrupted' })
    const inst = makeInstance()
    inst.state = 'running'
    inst.startTime = new Date('2026-07-17T08:00:00')
    inst.stopTime = new Date('2026-07-17T09:00:00')
    view.taskInstances = [inst]
    view.currentInstance = inst
    manager.getRuns.mockReturnValue([record])
    manager.claimInterruptedTaskStateReconciliation.mockReturnValue(true)

    const reconciliation = reconcile(view)
    expect(manager.completeInterruptedTaskStateReconciliation).not.toHaveBeenCalled()
    await reconciliation

    expect(execution.stopInstance).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
    expect(inst.startTime).toBeUndefined()
    expect(inst.stopTime).toBeUndefined()
    expect(view.currentInstance).toBeNull()
    expect(cleanup.runningTasksDelete).toHaveBeenCalledWith({
      taskPath: record.taskPath,
    })
    expect(cleanup.removeTaskLogForInstanceOnDate).toHaveBeenCalledWith(
      inst.instanceId,
      '2026-07-17',
      inst.task.taskId,
      inst.task.path,
    )
    expect(
      cleanup.removeTaskLogForInstanceOnDate.mock.invocationCallOrder[0] ??
        Infinity,
    ).toBeLessThan(
      cleanup.runningTasksDelete.mock.invocationCallOrder[0] ?? Infinity,
    )
    expect(manager.completeInterruptedTaskStateReconciliation).toHaveBeenCalledWith(
      record.id,
    )
    expect(manager.retryInterruptedTaskStateReconciliation).not.toHaveBeenCalled()
  })

  test('re-arms the durable marker when stopping the restored timer fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { manager, view } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const record = makeRecord({ status: 'interrupted' })
    const inst = makeInstance()
    inst.state = 'running'
    const startedAt = new Date('2026-07-17T08:00:00')
    inst.startTime = startedAt
    view.taskInstances = [inst]
    view.currentInstance = inst
    manager.getRuns.mockReturnValue([record])
    manager.claimInterruptedTaskStateReconciliation.mockReturnValue(true)
    manager.hasTaskRunLifecycle.mockReturnValue(true)
    cleanup.runningTasksDelete.mockRejectedValueOnce(
      new Error('state write failed'),
    )

    await reconcile(view)

    expect(manager.completeInterruptedTaskStateReconciliation).not.toHaveBeenCalled()
    expect(manager.retryInterruptedTaskStateReconciliation).toHaveBeenCalledWith(
      record.id,
    )
    expect(inst.state).toBe('running')
    expect(inst.startTime).toBe(startedAt)
    expect(view.currentInstance).toBe(inst)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('keeps the marker when this leaf cannot see a running timer', async () => {
    const { manager, view, execution } = setUp()
    const record = makeRecord({ status: 'interrupted' })
    view.taskInstances = [makeInstance()]
    manager.getRuns.mockReturnValue([record])
    manager.claimInterruptedTaskStateReconciliation.mockReturnValue(true)

    await reconcile(view)

    expect(execution.stopInstance).not.toHaveBeenCalled()
    expect(
      manager.coordinateInterruptedTaskStateReconciliation,
    ).not.toHaveBeenCalled()
    expect(manager.completeInterruptedTaskStateReconciliation).not.toHaveBeenCalled()
  })

  test('resets an orphaned AI timer when the workspace snapshot is missing', async () => {
    const { manager, view, execution } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const inst = makeInstance()
    inst.state = 'running'
    inst.startTime = new Date('2026-07-17T08:00:00')
    view.taskInstances = [inst]
    view.currentInstance = inst
    manager.getRuns.mockReturnValue([])
    manager.hasTaskRunLifecycle.mockReturnValue(false)

    await reconcile(view)

    expect(execution.stopInstance).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
    expect(inst.startTime).toBeUndefined()
    expect(view.currentInstance).toBeNull()
    expect(cleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
  })

  test('keeps running AI and human timers that are not orphaned AI runs', async () => {
    const { manager, view } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const pendingAi = makeInstance()
    pendingAi.state = 'running'
    const human = makeHumanInstance('Human')
    human.state = 'running'
    view.taskInstances = [pendingAi, human]
    manager.getRuns.mockReturnValue([])
    manager.hasTaskRunLifecycle.mockImplementation(
      (taskPath: string) => taskPath === pendingAi.task.path,
    )

    await reconcile(view)

    expect(pendingAi.state).toBe('running')
    expect(human.state).toBe('running')
    expect(cleanup.runningTasksDelete).not.toHaveBeenCalled()
  })

  test('resets every running duplicate owned by one interrupted AI run', async () => {
    const { manager, view } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const record = makeRecord({ status: 'interrupted' })
    const first = makeInstance()
    first.state = 'running'
    first.startTime = new Date('2026-07-17T08:00:00')
    const second = makeInstance()
    second.instanceId = 'inst-duplicate'
    second.state = 'running'
    second.startTime = new Date('2026-07-17T08:01:00')
    view.taskInstances = [first, second]
    manager.getRuns.mockReturnValue([record])
    manager.claimInterruptedTaskStateReconciliation.mockReturnValue(true)

    await reconcile(view)

    expect(first.state).toBe('idle')
    expect(second.state).toBe('idle')
    expect(cleanup.removeTaskLogForInstanceOnDate).toHaveBeenCalledTimes(2)
    expect(cleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
    expect(cleanup.runningTasksDelete).toHaveBeenCalledWith({
      taskPath: record.taskPath,
    })
  })

  test('all mounted views await one interrupted repair and idle their own instances', async () => {
    const plugin = createPluginStub()
    const manager = createManagerStub()
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
    const firstView = createView(plugin).view
    const secondView = createView(plugin).view
    const firstCleanup = stubInterruptedCleanup(firstView)
    const secondCleanup = stubInterruptedCleanup(secondView)
    const record = makeRecord({ status: 'interrupted' })
    const firstInstance = makeInstance()
    const secondInstance = makeInstance()
    firstInstance.state = 'running'
    secondInstance.state = 'running'
    firstInstance.startTime = new Date('2026-07-16T23:58:00')
    secondInstance.startTime = new Date('2026-07-16T23:58:00')
    firstView.taskInstances = [firstInstance]
    secondView.taskInstances = [secondInstance]
    manager.getRuns.mockReturnValue([record])

    let finishDelete: (count: number) => void = () => undefined
    firstCleanup.runningTasksDelete.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishDelete = resolve
        }),
    )
    let sharedRepair: Promise<boolean> | undefined
    manager.coordinateInterruptedTaskStateReconciliation.mockImplementation(
      (_runId, _generation, repair) => {
        if (sharedRepair) return sharedRepair
        sharedRepair = repair().then(() => true)
        return sharedRepair
      },
    )

    const firstReconciliation = reconcile(firstView)
    await flushPromises()
    const secondReconciliation = reconcile(secondView)
    await flushPromises()

    expect(firstInstance.state).toBe('idle')
    expect(secondInstance.state).toBe('running')
    expect(firstCleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
    expect(secondCleanup.runningTasksDelete).not.toHaveBeenCalled()
    expect(firstCleanup.removeTaskLogForInstanceOnDate).toHaveBeenCalledWith(
      firstInstance.instanceId,
      '2026-07-16',
      firstInstance.task.taskId,
      firstInstance.task.path,
    )

    finishDelete(1)
    await Promise.all([firstReconciliation, secondReconciliation])

    expect(firstInstance.state).toBe('idle')
    expect(secondInstance.state).toBe('idle')
    expect(firstCleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
    expect(secondCleanup.runningTasksDelete).not.toHaveBeenCalled()
  })

  test('a settled interrupted repair never idles a newer timer of the same task', async () => {
    const { manager, view } = setUp()
    const cleanup = stubInterruptedCleanup(view)
    const interruptedAt = new Date('2026-07-17T09:00:00').getTime()
    const record = makeRecord({
      status: 'interrupted',
      endedAt: interruptedAt,
      instanceId: 'inst-1',
    })
    const instance = makeInstance()
    instance.state = 'running'
    instance.startTime = new Date('2026-07-17T08:00:00')
    view.taskInstances = [instance]
    manager.getRuns.mockReturnValue([record])
    manager.claimInterruptedTaskStateReconciliation.mockReturnValue(true)

    await reconcile(view)
    expect(instance.state).toBe('idle')
    expect(cleanup.runningTasksDelete).toHaveBeenCalledTimes(1)

    manager.coordinateInterruptedTaskStateReconciliation.mockClear()
    manager.hasTaskRunLifecycle.mockReturnValue(true)
    instance.state = 'running'
    instance.startTime = new Date(interruptedAt + 1_000)

    await reconcile(view)

    expect(instance.state).toBe('running')
    expect(
      manager.coordinateInterruptedTaskStateReconciliation,
    ).not.toHaveBeenCalled()
    expect(cleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
  })

  test('all mounted views await one orphan repair and idle their own instances', async () => {
    const plugin = createPluginStub()
    const manager = createManagerStub()
    ;(plugin as { aiTaskManager?: unknown }).aiTaskManager = manager
    const firstView = createView(plugin).view
    const secondView = createView(plugin).view
    const firstCleanup = stubInterruptedCleanup(firstView)
    const secondCleanup = stubInterruptedCleanup(secondView)
    const firstInstance = makeInstance()
    const secondInstance = makeInstance()
    firstInstance.state = 'running'
    secondInstance.state = 'running'
    firstInstance.startTime = new Date('2026-07-17T08:00:00')
    secondInstance.startTime = new Date('2026-07-17T08:00:00')
    firstView.taskInstances = [firstInstance]
    secondView.taskInstances = [secondInstance]
    manager.getRuns.mockReturnValue([])
    manager.hasTaskRunLifecycle.mockReturnValue(false)

    let finishDelete: (count: number) => void = () => undefined
    firstCleanup.runningTasksDelete.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishDelete = resolve
        }),
    )
    let sharedRepair: Promise<boolean> | undefined
    manager.coordinateOrphanedTaskStateReconciliation.mockImplementation(
      (_taskPath, _owner, repair) => {
        if (sharedRepair) return sharedRepair
        sharedRepair = repair().then(() => true)
        return sharedRepair
      },
    )

    const firstReconciliation = reconcile(firstView)
    await flushPromises()
    const secondReconciliation = reconcile(secondView)
    await flushPromises()

    expect(firstInstance.state).toBe('idle')
    expect(secondInstance.state).toBe('running')
    expect(firstCleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
    expect(secondCleanup.runningTasksDelete).not.toHaveBeenCalled()

    finishDelete(1)
    await Promise.all([firstReconciliation, secondReconciliation])

    expect(firstInstance.state).toBe('idle')
    expect(secondInstance.state).toBe('idle')
    expect(firstCleanup.runningTasksDelete).toHaveBeenCalledTimes(1)
    expect(secondCleanup.runningTasksDelete).not.toHaveBeenCalled()
  })

  test('runs reconciliation only after reload restored task instances', async () => {
    const { view } = setUp()
    const order: string[] = []
    let finishReconciliation: () => void = () => undefined
    ;(
      view as unknown as {
        taskReloadCoordinator: {
          reloadTasksAndRestore(): Promise<void>
        }
        reconcileInterruptedAiRunTasks(): Promise<void>
      }
    ).taskReloadCoordinator = {
      reloadTasksAndRestore: jest.fn(async () => {
        order.push('reload')
      }),
    }
    ;(
      view as unknown as { reconcileInterruptedAiRunTasks(): Promise<void> }
    ).reconcileInterruptedAiRunTasks = jest.fn(() => {
      order.push('reconcile')
      return new Promise<void>((resolve) => {
        finishReconciliation = resolve
      })
    })

    let settled = false
    const reload = view
      .reloadTasksAndRestore({ runBoundaryCheck: true })
      .then(() => {
        settled = true
      })
    await flushPromises()

    expect(order).toEqual(['reload', 'reconcile'])
    expect(settled).toBe(false)
    finishReconciliation()
    await reload
    expect(settled).toBe(true)
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

  test('resetting a running human source stops its linked AI and allows a later retrigger', async () => {
    const { manager, view, execution } = setUp()
    stubResetInternals(view)
    manager.startRun.mockResolvedValue(makeRecord({ taskPath: 'TASKS/linked-ai.md' }))
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    view.taskInstances = [source, target]

    await view.startInstance(source)
    await asResetCapable(view).resetTaskToIdle(source)

    expect(target.state).toBe('done')
    expect(execution.stopInstance).toHaveBeenCalledWith(target, undefined)

    // Resetting clears coordinator ownership, so the same source can trigger
    // the link again when an idle target is available.
    target.state = 'idle'
    await view.startInstance(source)
    expect(execution.startInstance.mock.calls.filter(([inst]) => inst === target)).toHaveLength(2)
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

  test('a failed running-source deletion leaves its linked AI run alone', async () => {
    const { manager, view, mutation, execution } = setUp()
    const source = makeHumanInstance('CEO review')
    source.state = 'running'
    const target = makeLinkedAiInstance('CEO review')
    target.state = 'running'
    view.taskInstances = [source, target]
    mutation.deleteTask.mockResolvedValueOnce(false)

    await asDeleteCapable(view).deleteTask(source)

    expect(execution.stopInstance).not.toHaveBeenCalled()
    expect(manager.stopRun).not.toHaveBeenCalled()
  })

  test('deleting a running human source stops its owned linked AI instance', async () => {
    const { manager, view, execution } = setUp()
    manager.startRun.mockResolvedValue(makeRecord({ taskPath: 'TASKS/linked-ai.md' }))
    const source = makeHumanInstance('CEO review')
    const target = makeLinkedAiInstance('CEO review')
    view.taskInstances = [source, target]

    await view.startInstance(source)
    await asDeleteCapable(view).deleteTask(source)

    expect(execution.stopInstance).toHaveBeenCalledWith(target, undefined)
    expect(target.state).toBe('done')
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

describe('TaskChuteView Ambient AI routine bridge', () => {
  const dueAt = new Date(2026, 6, 15, 8, 0, 0, 0)

  function makeAmbientInstance(
    overrides: Record<string, unknown> = {},
  ): TaskInstance {
    const inst = makeInstance({
      ai_task: true,
      isRoutine: true,
      routine_type: 'daily',
      routine_enabled: true,
      scheduled_time: '08:00',
      ...overrides,
    })
    inst.task.isRoutine = true
    inst.task.scheduledTime =
      typeof overrides.scheduled_time === 'string'
        ? overrides.scheduled_time
        : '08:00'
    inst.date = '2026-07-15'
    return inst
  }

  function prepareAmbientView(view: TaskChuteView): void {
    view.currentDate = new Date(2026, 6, 15)
    view.reloadTasksAndRestore = jest.fn(async () => undefined)
    ;(
      view.taskHeaderController as unknown as {
        refreshDateLabel: jest.Mock
      }
    ).refreshDateLabel = jest.fn()
    ;(
      view as unknown as {
        removeRunningTaskRecord: jest.Mock
        saveRunningTasksState: jest.Mock
      }
    ).removeRunningTaskRecord = jest.fn(async () => undefined)
    ;(
      view as unknown as {
        saveRunningTasksState: jest.Mock
      }
    ).saveRunningTasksState = jest.fn(async () => undefined)
  }

  function makeAmbientStartedRun(
    overrides: Partial<AmbientAiTaskStartedRun> = {},
  ): AmbientAiTaskStartedRun {
    return {
      runId: 'ai-run-1',
      path: TASK_PATH,
      instanceId: 'inst-1',
      startTime: new Date(2026, 6, 15, 8, 0, 5, 123).getTime(),
      slotKey: '8:00-12:00',
      originalSlotKey: 'none',
      ...overrides,
    }
  }

  test('recipe preflight failure leaves an Ambient candidate idle and retryable', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    manager.prepareRun = jest.fn().mockRejectedValueOnce(
      new Error('Recipe could not be loaded'),
    )
    manager.startPreparedRun = jest.fn()
    const inst = makeAmbientInstance({
      recipe: '[[TaskChute/Recipes/Missing]]',
    })
    view.taskInstances = [inst]

    const result = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(result).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startPreparedRun).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
  })

  test('starts a due unlinked AI routine and reports it for once-per-day persistence', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    manager.startRun.mockResolvedValueOnce(makeRecord())
    const inst = makeAmbientInstance()
    const timerStartedAt = new Date(2026, 6, 15, 8, 0, 5, 123)
    execution.startInstance.mockImplementationOnce(async (target) => {
      target.state = 'running'
      target.startTime = timerStartedAt
      target.originalSlotKey = 'none'
      target.slotKey = '8:00-12:00'
      return true
    })
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({
      satisfiedPaths: [TASK_PATH],
      startedRuns: [
        {
          runId: 'ai-run-1',
          path: TASK_PATH,
          instanceId: inst.instanceId,
          startTime: timerStartedAt.getTime(),
          slotKey: '8:00-12:00',
          originalSlotKey: 'none',
        },
      ],
    })
    expect(execution.startInstance).toHaveBeenCalledWith(inst)
    expect(manager.startRun).toHaveBeenCalledTimes(1)
    expect(inst.state).toBe('running')
  })

  test('does not start before the scheduled time', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks(
      [TASK_PATH],
      new Date(2026, 6, 15, 7, 59, 59),
    )

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test('keeps an Obsidian-linked AI routine click-only even after its time', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance({
      obsidian_sync: {
        enabled: true,
        taskTitle: 'CEO review',
        matchType: 'exact',
      },
    })
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test.each(['running', 'done', 'paused'] as const)(
    'treats an already %s routine as satisfied without a duplicate run',
    async (state) => {
      const { manager, view, execution } = setUp()
      prepareAmbientView(view)
      const inst = makeAmbientInstance()
      inst.state = state
      view.taskInstances = [inst]

      const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

      expect(satisfied).toEqual({
        satisfiedPaths: [TASK_PATH],
        startedRuns: [],
      })
      expect(execution.startInstance).not.toHaveBeenCalled()
      expect(manager.startRun).not.toHaveBeenCalled()
    },
  )

  test('rolls the timer back and leaves the date unmarked when AI dispatch fails', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    manager.startRun.mockRejectedValueOnce(new AiBinaryNotFoundError('claude'))
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(execution.startInstance).toHaveBeenCalledWith(inst)
    expect(inst.state).toBe('idle')
    expect(
      (view as unknown as { removeRunningTaskRecord: jest.Mock })
        .removeRunningTaskRecord,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ taskPath: TASK_PATH }),
    )
  })

  test('rolls back an already-active pending-start race so a failed owner can be retried', async () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    manager.startRun.mockRejectedValueOnce(
      new AiRunAlreadyActiveError(TASK_PATH),
    )
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(manager.getActiveRunForTask).toHaveBeenCalledWith(TASK_PATH)
    expect(inst.state).toBe('idle')
  })

  test('stops the old process and rolls back when the AI manager changes during dispatch', async () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    const plugin = (view as unknown as { plugin: TaskChutePluginLike }).plugin
    manager.startRun.mockImplementationOnce(async () => {
      plugin.aiTaskManager = createManagerStub() as unknown as typeof plugin.aiTaskManager
      return makeRecord()
    })
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(inst.state).toBe('idle')
    expect(manager.requestStopForTask).toHaveBeenCalledWith(TASK_PATH)
  })

  test('does not borrow or change a view that is showing another date', async () => {
    const { manager, view, execution } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]
    view.currentDate = new Date(2026, 6, 10)

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(view.getCurrentDateString()).toBe('2026-07-10')
    expect(view.reloadTasksAndRestore).not.toHaveBeenCalled()
    expect(execution.startInstance).not.toHaveBeenCalled()
    expect(manager.startRun).not.toHaveBeenCalled()
  })

  test('retries when a transient load failure leaves the candidate path absent', async () => {
    const { view, execution } = setUp()
    prepareAmbientView(view)
    view.taskInstances = []

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({ satisfiedPaths: [], startedRuns: [] })
    expect(execution.startInstance).not.toHaveBeenCalled()
  })

  test('marks an explicitly hidden candidate as satisfied without launching it', async () => {
    const { view, execution } = setUp()
    prepareAmbientView(view)
    view.taskInstances = []
    view.dayStateManager.isHidden = jest.fn(() => true)

    const satisfied = await view.runDueAmbientAiTasks([TASK_PATH], dueAt)

    expect(satisfied).toEqual({
      satisfiedPaths: [TASK_PATH],
      startedRuns: [],
    })
    expect(execution.startInstance).not.toHaveBeenCalled()
  })

  test('syncs the exact background instance and timer snapshot without rechecking the active run', () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    const startedAt = new Date(2026, 6, 15, 9, 5, 0, 0).getTime()
    const fallback = makeAmbientInstance()
    fallback.instanceId = 'fallback-instance'
    const exact = makeAmbientInstance()
    exact.instanceId = 'background-instance'
    view.taskInstances = [fallback, exact]
    view.startGlobalTimer = jest.fn()
    view.restartTimerService = jest.fn()

    view.syncAmbientAiTaskRuns(
      [
        makeAmbientStartedRun({
          instanceId: exact.instanceId,
          startTime: startedAt,
          slotKey: '12:00-16:00',
          originalSlotKey: '8:00-12:00',
        }),
      ],
      '2026-07-15',
    )

    expect(manager.getActiveRunForTask).not.toHaveBeenCalled()
    expect(fallback.state).toBe('idle')
    expect(exact.state).toBe('running')
    expect(exact.startTime?.getTime()).toBe(startedAt)
    expect(exact.slotKey).toBe('12:00-16:00')
    expect(exact.originalSlotKey).toBe('8:00-12:00')
    expect(view.currentInstance).toBe(exact)
    expect(view.startGlobalTimer).toHaveBeenCalledTimes(1)
    expect(view.restartTimerService).toHaveBeenCalledTimes(1)
    expect(view.renderTaskList).toHaveBeenCalledTimes(1)
  })

  test('falls back to the task path when the background instance id is unavailable in the visible view', () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]
    view.startGlobalTimer = jest.fn()
    view.restartTimerService = jest.fn()
    const startedRun = makeAmbientStartedRun({
      instanceId: 'background-only-instance',
    })

    view.syncAmbientAiTaskRuns([startedRun], '2026-07-15')

    expect(manager.getActiveRunForTask).not.toHaveBeenCalled()
    expect(inst.state).toBe('running')
    expect(inst.startTime?.getTime()).toBe(startedRun.startTime)
    expect(inst.slotKey).toBe(startedRun.slotKey)
    expect(inst.originalSlotKey).toBe(startedRun.originalSlotKey)
    expect(view.currentInstance).toBe(inst)
  })

  test('opens exact Ambient runs in start order even when their timers are already mirrored', () => {
    const { view } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    inst.state = 'running'
    view.taskInstances = [inst]
    const openRun = jest.fn()
    ;(
      view as unknown as {
        aiRunPaneController: { openRun: jest.Mock }
      }
    ).aiRunPaneController = { openRun }

    view.syncAmbientAiTaskRuns(
      [
        makeAmbientStartedRun({ runId: 'ai-run-ambient-a' }),
        makeAmbientStartedRun({
          runId: 'ai-run-ambient-b',
          path: 'TASKS/other-ambient.md',
          instanceId: 'other-ambient-instance',
        }),
      ],
      '2026-07-15',
    )

    // AiRunPaneController.openRun owns reveal + uncollapse + selection. The
    // final call therefore leaves the last run from this scheduler tick open.
    expect(openRun.mock.calls.map(([runId]) => runId)).toEqual([
      'ai-run-ambient-a',
      'ai-run-ambient-b',
    ])
    expect(view.renderTaskList).not.toHaveBeenCalled()
  })

  test('mirrors the authoritative timer snapshot even when startRun exits immediately', async () => {
    const background = setUp()
    prepareAmbientView(background.view)
    const timerStartedAt = new Date(2026, 6, 15, 8, 0, 7, 456)
    const backgroundInstance = makeAmbientInstance()
    background.execution.startInstance.mockImplementationOnce(async (target) => {
      target.state = 'running'
      target.startTime = timerStartedAt
      target.originalSlotKey = 'none'
      target.slotKey = '8:00-12:00'
      return true
    })
    background.manager.startRun.mockResolvedValueOnce(
      makeRecord({
        status: 'succeeded',
        startedAt: timerStartedAt.getTime() - 5_000,
        endedAt: timerStartedAt.getTime() - 4_000,
      }),
    )
    background.view.taskInstances = [backgroundInstance]

    const result = await background.view.runDueAmbientAiTasks(
      [TASK_PATH],
      dueAt,
    )

    const visible = setUp()
    prepareAmbientView(visible.view)
    const visibleInstance = makeAmbientInstance()
    visible.view.taskInstances = [visibleInstance]
    visible.view.startGlobalTimer = jest.fn()
    visible.view.restartTimerService = jest.fn()

    visible.view.syncAmbientAiTaskRuns(result.startedRuns, '2026-07-15')

    expect(result.startedRuns).toEqual([
      {
        runId: 'ai-run-1',
        path: TASK_PATH,
        instanceId: backgroundInstance.instanceId,
        startTime: timerStartedAt.getTime(),
        slotKey: '8:00-12:00',
        originalSlotKey: 'none',
      },
    ])
    expect(visible.manager.getActiveRunForTask).not.toHaveBeenCalled()
    expect(visibleInstance.state).toBe('running')
    expect(visibleInstance.startTime?.getTime()).toBe(timerStartedAt.getTime())
    expect(visibleInstance.slotKey).toBe('8:00-12:00')
    expect(visibleInstance.originalSlotKey).toBe('none')
    expect(visible.view.currentInstance).toBe(visibleInstance)
  })

  test('does not sync a run whose path was not selected for mirroring', () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]
    view.startGlobalTimer = jest.fn()
    view.restartTimerService = jest.fn()

    view.syncAmbientAiTaskRuns(
      [
        makeAmbientStartedRun({
          path: 'TASKS/other-ai-task.md',
          instanceId: 'other-instance',
        }),
      ],
      '2026-07-15',
    )

    expect(manager.getActiveRunForTask).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
    expect(inst.startTime).toBeUndefined()
    expect(view.currentInstance).toBeNull()
    expect(view.startGlobalTimer).not.toHaveBeenCalled()
    expect(view.restartTimerService).not.toHaveBeenCalled()
    expect(view.renderTaskList).not.toHaveBeenCalled()
  })

  test('does not sync an ambient run into a view showing another date', () => {
    const { manager, view } = setUp()
    prepareAmbientView(view)
    const inst = makeAmbientInstance()
    view.taskInstances = [inst]
    view.startGlobalTimer = jest.fn()
    view.restartTimerService = jest.fn()

    view.syncAmbientAiTaskRuns(
      [makeAmbientStartedRun()],
      '2026-07-14',
    )

    expect(manager.getActiveRunForTask).not.toHaveBeenCalled()
    expect(inst.state).toBe('idle')
    expect(inst.startTime).toBeUndefined()
    expect(view.currentInstance).toBeNull()
    expect(view.startGlobalTimer).not.toHaveBeenCalled()
    expect(view.restartTimerService).not.toHaveBeenCalled()
    expect(view.renderTaskList).not.toHaveBeenCalled()
  })
})
