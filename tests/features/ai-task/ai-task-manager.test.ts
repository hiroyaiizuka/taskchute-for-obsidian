import { TFile } from 'obsidian'
import {
  AiTaskManager,
  AiPromptNotFoundError,
  AiRunAlreadyActiveError,
  AiRunNotFoundError,
  AiSessionUnavailableError,
  AiTaskManagerDisposedError,
  AiTaskNotConfiguredError,
  AI_RUN_EVENT_HEAD_LIMIT,
  AI_RUN_EVENT_TAIL_LIMIT,
  DISPOSE_FORCE_KILL_MS,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiDispatcher,
  AiRunCallbacks,
  AiRunExitOutcome,
  AiRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type { AiRunRecord, AiStreamEvent } from '../../../src/features/ai-task/types'
import type { AiBinaryResolution } from '../../../src/features/ai-task/services/BinaryLocator'

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeTaskFile(path = 'TaskChute/Task/My Task.md', basename = 'My Task'): TFile {
  const file = new TFile()
  file.path = path
  file.basename = basename
  file.extension = 'md'
  return file
}

interface FakeRun {
  request: AiRunRequest
  callbacks: AiRunCallbacks
  stop: jest.Mock
  forceKill: jest.Mock
  emit(event: AiStreamEvent): void
  exit(outcome: AiRunExitOutcome): void
}

class FakeDispatcher implements AiDispatcher {
  runs: FakeRun[] = []
  /** When set, the next start() throws this error synchronously (spawn failure) */
  failNextStart: Error | null = null

  start(request: AiRunRequest, callbacks: AiRunCallbacks) {
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = null
      throw error
    }
    const run: FakeRun = {
      request,
      callbacks,
      stop: jest.fn(),
      forceKill: jest.fn(),
      emit: (event) => callbacks.onEvent(event),
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return { pid: 4321, stop: run.stop, forceKill: run.forceKill }
  }

  get last(): FakeRun {
    if (this.runs.length === 0) throw new Error('No dispatcher run started')
    return this.runs[this.runs.length - 1]
  }
}

interface FiringTimer {
  scheduled: Array<{ handler: () => void; timeoutMs: number; handle: number }>
  cleared: number[]
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
  fireAll(): void
}

function createFiringTimer(): FiringTimer {
  const scheduled: Array<{ handler: () => void; timeoutMs: number; handle: number }> = []
  const cleared: number[] = []
  let nextHandle = 1
  return {
    scheduled,
    cleared,
    setTimeout: (handler, timeoutMs) => {
      const handle = nextHandle
      nextHandle += 1
      scheduled.push({ handler, timeoutMs, handle })
      return handle
    },
    clearTimeout: (handle) => {
      cleared.push(handle)
    },
    fireAll: () => {
      for (const entry of scheduled.splice(0)) entry.handler()
    },
  }
}

interface HarnessOptions {
  frontmatter?: Record<string, unknown> | null
  content?: string
  basePath?: string | null
  resolveBinary?: (
    host: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<AiBinaryResolution>
  cachedRead?: () => Promise<string>
  /** When true, the log writer also exposes the upsert path used for rewrites */
  withUpsert?: boolean
  /** Exercise the production root-window timer instead of the recording fake. */
  useDefaultTimer?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const claude = new FakeDispatcher()
  const codex = new FakeDispatcher()
  const timer = createFiringTimer()
  const writeRunLog = jest.fn(async () => 'log-path.md')
  const upsertRunLog = jest.fn<Promise<string>, [AiRunRecord, AiStreamEvent[]?]>(
    async () => 'upsert-log-path.md',
  )
  const pruneOldLogs = jest.fn(async () => undefined)
  const resolve = jest.fn(
    options.resolveBinary ?? ((host: string) => Promise.resolve(`/bin/${host}`)),
  )
  const invalidateCache = jest.fn()
  const frontmatter =
    options.frontmatter === undefined ? { ai_task: true } : options.frontmatter
  const content = options.content ?? '# Task\n\n## Prompt\n\nDo the thing\n'
  const basePath = options.basePath === undefined ? '/vault/base' : options.basePath

  const deps: AiTaskManagerDeps = {
    app: {
      vault: {
        cachedRead: jest.fn(options.cachedRead ?? (async () => content)),
        adapter:
          basePath === null
            ? {}
            : {
                getBasePath: () => basePath,
              },
      },
      metadataCache: {
        getFileCache: jest.fn(() => (frontmatter ? { frontmatter } : null)),
      },
    },
    dispatchers: { claude, codex },
    binaryLocator: { resolve, invalidateCache },
    logWriter: options.withUpsert
      ? { writeRunLog, upsertRunLog, pruneOldLogs }
      : { writeRunLog, pruneOldLogs },
  }
  if (!options.useDefaultTimer) deps.timer = timer

  return {
    manager: new AiTaskManager(deps),
    claude,
    codex,
    timer,
    writeRunLog,
    upsertRunLog,
    pruneOldLogs,
    resolve,
    invalidateCache,
  }
}

describe('AiTaskManager.startRun', () => {
  test('does not retry a CLI that launched and then exited 127 before output', async () => {
    const harness = createHarness({
      resolveBinary: async (_host, options) =>
        options?.forceRefresh ? '/bin/claude-v2' : '/bin/claude-v1',
    })

    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.exit({
      status: 'failed',
      exitCode: 127,
      signal: null,
      errorMessage: 'command not found',
    })
    await flushPromises()

    expect(harness.invalidateCache).not.toHaveBeenCalled()
    expect(harness.resolve).toHaveBeenCalledTimes(1)
    expect(harness.claude.runs).toHaveLength(1)
    expect(harness.claude.runs[0].request.binaryPath).toBe('/bin/claude-v1')
    expect(record.status).toBe('failed')
  })

  test('re-resolves and retries exactly once after a structured OS launch failure', async () => {
    const harness = createHarness({
      resolveBinary: async (_host, options) =>
        options?.forceRefresh ? '/bin/claude-v2' : '/bin/claude-v1',
    })

    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'spawn ENOENT',
      launchError: { code: 'ENOENT', message: 'spawn ENOENT' },
    })
    await flushPromises()

    expect(harness.invalidateCache).toHaveBeenCalledWith('claude')
    expect(harness.resolve).toHaveBeenNthCalledWith(1, 'claude')
    expect(harness.resolve).toHaveBeenNthCalledWith(2, 'claude', {
      forceRefresh: true,
    })
    expect(harness.claude.runs).toHaveLength(2)
    expect(harness.claude.runs[1].request.binaryPath).toBe('/bin/claude-v2')
    expect(record.status).toBe('running')

    harness.claude.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'still missing',
      launchError: { code: 'ENOENT', message: 'still missing' },
    })
    await flushPromises()
    expect(harness.claude.runs).toHaveLength(2)
    expect(record.status).toBe('failed')
  })

  test('does not retry status 127 after any CLI event, preventing duplicate prompts', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.emit({ kind: 'assistant-text', text: 'started' })
    harness.claude.last.exit({
      status: 'failed',
      exitCode: 127,
      signal: null,
      errorMessage: 'tool returned 127',
    })
    await flushPromises()

    expect(harness.claude.runs).toHaveLength(1)
    expect(harness.resolve).toHaveBeenCalledTimes(1)
    expect(record.status).toBe('failed')
  })

  test('does not retry a non-recoverable pre-output CLI failure', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.exit({
      status: 'failed',
      exitCode: 2,
      signal: null,
      errorMessage: 'invalid option',
    })
    await flushPromises()

    expect(harness.claude.runs).toHaveLength(1)
    expect(harness.resolve).toHaveBeenCalledTimes(1)
    expect(harness.invalidateCache).not.toHaveBeenCalled()
    expect(record.status).toBe('failed')
  })

  test('retries a synchronous ENOENT throw without publishing the proxy as the final handle', async () => {
    const harness = createHarness()
    harness.claude.failNextStart = Object.assign(new Error('spawn ENOENT'), {
      code: 'ENOENT',
    })

    const record = await harness.manager.startRun(makeTaskFile())
    await flushPromises()

    expect(harness.claude.runs).toHaveLength(1)
    expect(harness.resolve).toHaveBeenNthCalledWith(2, 'claude', {
      forceRefresh: true,
    })
    expect(record.status).toBe('running')
    expect(record.pid).toBe(4321)
  })

  test('a stop during forced re-resolution prevents the retry child from spawning', async () => {
    let releaseResolution: ((value: AiBinaryResolution) => void) | undefined
    const harness = createHarness({
      resolveBinary: async (_host, options) => {
        if (!options?.forceRefresh) return '/bin/claude-v1'
        return await new Promise<AiBinaryResolution>((resolve) => {
          releaseResolution = resolve
        })
      },
    })
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'spawn ENOENT',
      launchError: { code: 'ENOENT', message: 'spawn ENOENT' },
    })
    await Promise.resolve()

    harness.manager.stopRun(record.id)
    releaseResolution?.('/bin/claude-v2')
    await flushPromises()

    expect(harness.claude.runs).toHaveLength(1)
    expect(record.status).toBe('stopped')
  })

  test('starts a claude run and transitions starting -> running', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_args: '--max-turns 1' },
    })
    const statuses: string[] = []
    harness.manager.onChange((record) => statuses.push(record.status))

    const record = await harness.manager.startRun(makeTaskFile())

    expect(harness.resolve).toHaveBeenCalledWith('claude')
    expect(harness.claude.runs).toHaveLength(1)
    expect(harness.claude.last.request).toEqual({
      binaryPath: '/bin/claude',
      prompt: 'Do the thing',
      cwd: '/vault/base',
      extraArgs: ['--max-turns', '1'],
    })
    expect(record.status).toBe('running')
    expect(record.pid).toBe(4321)
    expect(record.taskPath).toBe('TaskChute/Task/My Task.md')
    expect(record.taskName).toBe('My Task')
    expect(record.host).toBe('claude')
    expect(statuses).toEqual(['starting', 'running'])
    expect(harness.manager.getRun(record.id)).toBe(record)
    expect(harness.manager.getRuns()).toEqual([record])
  })

  test('routes ai_task_host codex to the codex dispatcher', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_host: 'codex' },
    })

    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.host).toBe('codex')
    expect(harness.codex.runs).toHaveLength(1)
    expect(harness.claude.runs).toHaveLength(0)
    expect(harness.resolve).toHaveBeenCalledWith('codex')
  })

  test('passes a package-backed binary prefix from the locator to the dispatcher', async () => {
    const harness = createHarness({
      resolveBinary: async () => ({
        binaryPath: 'C:\\Program Files\\nodejs\\node.exe',
        argsPrefix: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'],
      }),
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request).toMatchObject({
      binaryPath: 'C:\\Program Files\\nodejs\\node.exe',
      binaryArgsPrefix: [
        'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs',
      ],
    })
  })

  test('passes the production LaunchSpec env and fixed terminal lookup metadata', async () => {
    const harness = createHarness({
      resolveBinary: async () => ({
        executable: '/stable/shims/claude',
        argvPrefix: [],
        envPatch: { TASKCHUTE_LAUNCH_TEST: 'yes' },
        source: 'path',
        packageManager: 'asdf',
        resolvedAt: Date.now(),
        pathFingerprint: 'linux\u0000/stable/shims:/usr/bin',
        requiredFiles: ['/stable/shims/claude'],
        terminalCommand: 'claude',
      }),
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request).toMatchObject({
      binaryPath: '/stable/shims/claude',
      envPatch: { TASKCHUTE_LAUNCH_TEST: 'yes' },
    })
  })

  test('keeps an absolute ai_task_cwd as-is', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_cwd: '/absolute/dir' },
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBe('/absolute/dir')
  })

  test.each([
    ['backslash drive path', 'C:\\Users\\me\\project'],
    ['forward-slash drive path', 'D:/Users/me/project'],
    ['UNC share path', '\\\\build-server\\projects\\taskchute-plus'],
  ])('keeps an absolute Windows %s as-is', async (_label, cwd) => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_cwd: cwd },
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBe(cwd)
  })

  test.each([
    ['drive-relative path', 'C:..\\outside'],
    ['UNC path without a share', '\\\\build-server'],
    ['UNC path with a traversal share', '\\\\build-server\\..\\outside'],
  ])('does not treat a Windows %s as absolute', async (_label, cwd) => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_cwd: cwd },
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBe(`/vault/base/${cwd}`)
  })

  test('joins a relative ai_task_cwd onto the vault base path', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_cwd: 'sub/dir' },
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBe('/vault/base/sub/dir')
  })

  test('falls back to no cwd when the adapter exposes no base path', async () => {
    const harness = createHarness({ basePath: null })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBeUndefined()
  })

  test('rejects when the note is not an AI task', async () => {
    const harness = createHarness({ frontmatter: { ai_task: false } })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiTaskNotConfiguredError,
    )
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('rejects when the note has no prompt section', async () => {
    const harness = createHarness({ content: '# Task\n\nNo prompt heading here\n' })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiPromptNotFoundError,
    )
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('rejects a second run for the same task while one is active', async () => {
    const harness = createHarness()

    const record = await harness.manager.startRun(makeTaskFile())
    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )
    expect(harness.claude.runs).toHaveLength(1)

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    expect(harness.manager.getActiveRunForTask(record.taskPath)).toBeUndefined()

    await expect(harness.manager.startRun(makeTaskFile())).resolves.toBeDefined()
    expect(harness.claude.runs).toHaveLength(2)
  })

  test('rejects concurrent duplicate starts before dispatch', async () => {
    const harness = createHarness()

    const results = await Promise.allSettled([
      harness.manager.startRun(makeTaskFile()),
      harness.manager.startRun(makeTaskFile()),
    ])

    const fulfilled = results.filter((entry) => entry.status === 'fulfilled')
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(AiRunAlreadyActiveError)
    expect(harness.claude.runs).toHaveLength(1)
  })

  test('reports a task lifecycle while its run is still pending', async () => {
    let resolveRead: (content: string) => void = () => undefined
    const harness = createHarness({
      cachedRead: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    })

    const startPromise = harness.manager.startRun(makeTaskFile())

    expect(
      harness.manager.hasTaskRunLifecycle('TaskChute/Task/My Task.md'),
    ).toBe(true)
    resolveRead('# Task\n\n## Prompt\n\nDo the thing\n')
    await startPromise
    expect(
      harness.manager.hasTaskRunLifecycle('TaskChute/Task/My Task.md'),
    ).toBe(true)
  })

  test('keeps a prepared TaskChute start owned while its timer reloads', async () => {
    const harness = createHarness()
    const file = makeTaskFile()
    const prepared = await harness.manager.prepareRun(file)
    const reservation = harness.manager.reserveTaskStart(file.path)

    expect(harness.manager.hasTaskRunLifecycle(file.path)).toBe(true)
    expect(
      harness.manager.claimOrphanedTaskStateReconciliation(file.path, {
        instanceId: 'timer-1',
        timerStartedAt: Date.now(),
      }),
    ).toBe(false)
    await expect(harness.manager.startRun(file)).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )

    const record = await harness.manager.startPreparedRun(
      prepared,
      { instanceId: 'timer-1' },
      reservation,
    )

    expect(record.instanceId).toBe('timer-1')
    expect(record.status).toBe('running')
    expect(harness.claude.runs).toHaveLength(1)
  })

  test('releases a cancelled prepared-start reservation without poisoning a later run', async () => {
    const harness = createHarness()
    const file = makeTaskFile()
    await harness.manager.prepareRun(file)
    const reservation = harness.manager.reserveTaskStart(file.path)

    harness.manager.requestStopForTask(file.path)
    harness.manager.releaseTaskStartReservation(reservation)
    harness.manager.releaseTaskStartReservation(reservation)

    expect(harness.manager.hasTaskRunLifecycle(file.path)).toBe(false)
    const record = await harness.manager.startRun(file)
    expect(record.status).toBe('running')
    expect(harness.claude.last.stop).not.toHaveBeenCalled()
  })

  test('honours a stop requested during the prepared-start reservation', async () => {
    const harness = createHarness()
    const file = makeTaskFile()
    const prepared = await harness.manager.prepareRun(file)
    const reservation = harness.manager.reserveTaskStart(file.path)

    harness.manager.requestStopForTask(file.path)
    const record = await harness.manager.startPreparedRun(
      prepared,
      { instanceId: 'timer-stop' },
      reservation,
    )

    expect(record.status).toBe('stopping')
    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)
  })

  test('rejects a forged or stale prepared-start reservation', async () => {
    const harness = createHarness()
    const file = makeTaskFile()
    const prepared = await harness.manager.prepareRun(file)
    const reservation = harness.manager.reserveTaskStart(file.path)
    harness.manager.releaseTaskStartReservation(reservation)

    await expect(
      harness.manager.startPreparedRun(
        prepared,
        undefined,
        reservation,
      ),
    ).rejects.toBeInstanceOf(AiRunAlreadyActiveError)
    expect(harness.claude.runs).toHaveLength(0)
  })

  test('matches a finished run only to the timer instance it actually owned', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile(), {
      instanceId: 'instance-1',
    })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    const endedAt = record.endedAt
    if (endedAt === undefined) throw new Error('endedAt was not recorded')

    expect(
      harness.manager.hasTaskRunLifecycle(record.taskPath, {
        instanceId: 'instance-1',
        timerStartedAt: record.startedAt - 1,
      }),
    ).toBe(true)
    expect(
      harness.manager.hasTaskRunLifecycle(record.taskPath, {
        instanceId: 'instance-1',
        timerStartedAt: endedAt + 1,
      }),
    ).toBe(false)
    expect(
      harness.manager.hasTaskRunLifecycle(record.taskPath, {
        instanceId: 'another-instance',
        timerStartedAt: record.startedAt - 1,
      }),
    ).toBe(false)
  })

  test('serializes orphan timer repair claims and blocks a racing fresh start', async () => {
    const harness = createHarness()
    const owner = { instanceId: 'orphan-instance', timerStartedAt: 1_000 }

    expect(
      harness.manager.claimOrphanedTaskStateReconciliation(
        'TaskChute/Task/My Task.md',
        owner,
      ),
    ).toBe(true)
    expect(
      harness.manager.claimOrphanedTaskStateReconciliation(
        'TaskChute/Task/My Task.md',
        owner,
      ),
    ).toBe(false)
    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )

    harness.manager.releaseOrphanedTaskStateReconciliation(
      'TaskChute/Task/My Task.md',
      owner.instanceId,
    )
    expect(
      harness.manager.claimOrphanedTaskStateReconciliation(
        'TaskChute/Task/My Task.md',
        owner,
      ),
    ).toBe(true)
    harness.manager.releaseOrphanedTaskStateReconciliation(
      'TaskChute/Task/My Task.md',
      owner.instanceId,
    )
    await expect(harness.manager.startRun(makeTaskFile())).resolves.toBeDefined()
  })

  test('shares one orphan repair promise and lets late views observe completion', async () => {
    const harness = createHarness()
    const taskPath = 'TaskChute/Task/My Task.md'
    const owner = { instanceId: 'orphan-instance', timerStartedAt: 1_000 }
    let finishRepair: () => void = () => undefined
    const repair = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRepair = resolve
        }),
    )

    const first = harness.manager.coordinateOrphanedTaskStateReconciliation(
      taskPath,
      owner,
      repair,
    )
    const second = harness.manager.coordinateOrphanedTaskStateReconciliation(
      taskPath,
      owner,
      repair,
    )
    await Promise.resolve()

    expect(repair).toHaveBeenCalledTimes(1)
    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )

    finishRepair()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    const lateRepair = jest.fn(async () => undefined)
    await expect(
      harness.manager.coordinateOrphanedTaskStateReconciliation(
        taskPath,
        owner,
        lateRepair,
      ),
    ).resolves.toBe(true)
    expect(lateRepair).not.toHaveBeenCalled()
    await expect(harness.manager.startRun(makeTaskFile())).resolves.toBeDefined()
  })

  test('allows parallel runs for different tasks', async () => {
    const harness = createHarness()

    await harness.manager.startRun(makeTaskFile('TaskChute/Task/A.md', 'A'))
    await harness.manager.startRun(makeTaskFile('TaskChute/Task/B.md', 'B'))

    expect(harness.claude.runs).toHaveLength(2)
    expect(harness.manager.getActiveRunForTask('TaskChute/Task/A.md')?.taskName).toBe('A')
    expect(harness.manager.getActiveRunForTask('TaskChute/Task/B.md')?.taskName).toBe('B')
  })
})

describe('AiTaskManager events and exit mapping', () => {
  test('appends stream events and notifies listeners', async () => {
    const harness = createHarness()
    const listener = jest.fn()
    harness.manager.onChange(listener)

    const record = await harness.manager.startRun(makeTaskFile())
    const callsBefore = listener.mock.calls.length
    harness.claude.last.emit({ kind: 'assistant-text', text: 'hi' })

    expect(record.events).toEqual([{ kind: 'assistant-text', text: 'hi' }])
    expect(listener.mock.calls.length).toBe(callsBefore + 1)
    // Stream-event notifications are regular updates (only the end of the
    // persist chain fires the 'persisted' changeType).
    expect(listener).toHaveBeenLastCalledWith(record, 'update')
  })

  test('onChange disposer stops notifications', async () => {
    const harness = createHarness()
    const listener = jest.fn()
    const dispose = harness.manager.onChange(listener)

    await harness.manager.startRun(makeTaskFile())
    const callsBefore = listener.mock.calls.length
    dispose()
    harness.claude.last.emit({ kind: 'assistant-text', text: 'later' })

    expect(listener.mock.calls.length).toBe(callsBefore)
  })

  test('caps the event buffer to head + elision marker + tail', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    const total = AI_RUN_EVENT_HEAD_LIMIT + AI_RUN_EVENT_TAIL_LIMIT + 110
    for (let index = 0; index < total; index += 1) {
      harness.claude.last.emit({ kind: 'raw', text: `event-${index}` })
    }

    expect(record.events).toHaveLength(
      AI_RUN_EVENT_HEAD_LIMIT + 1 + AI_RUN_EVENT_TAIL_LIMIT,
    )
    expect(record.omittedEventCount).toBe(110)
    expect(record.events[0]).toEqual({ kind: 'raw', text: 'event-0' })
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT - 1]).toEqual({
      kind: 'raw',
      text: `event-${AI_RUN_EVENT_HEAD_LIMIT - 1}`,
    })
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT]).toEqual({
      kind: 'elision',
      omittedCount: 110,
    })
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT + 1]).toEqual({
      kind: 'raw',
      text: `event-${AI_RUN_EVENT_HEAD_LIMIT + 110}`,
    })
    expect(record.events[record.events.length - 1]).toEqual({
      kind: 'raw',
      text: `event-${total - 1}`,
    })
  })

  test('keeps every event verbatim at exactly the cap boundary', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    const capacity = AI_RUN_EVENT_HEAD_LIMIT + AI_RUN_EVENT_TAIL_LIMIT
    for (let index = 0; index < capacity; index += 1) {
      harness.claude.last.emit({ kind: 'raw', text: `event-${index}` })
    }

    // Exactly at capacity: nothing is elided yet.
    expect(record.events).toHaveLength(capacity)
    expect(record.omittedEventCount).toBeUndefined()
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT]).toEqual({
      kind: 'raw',
      text: `event-${AI_RUN_EVENT_HEAD_LIMIT}`,
    })

    // First event past capacity: exactly one event is elided.
    harness.claude.last.emit({ kind: 'raw', text: `event-${capacity}` })

    expect(record.events).toHaveLength(AI_RUN_EVENT_HEAD_LIMIT + 1 + AI_RUN_EVENT_TAIL_LIMIT)
    expect(record.omittedEventCount).toBe(1)
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT]).toEqual({
      kind: 'elision',
      omittedCount: 1,
    })
    expect(record.events[AI_RUN_EVENT_HEAD_LIMIT + 1]).toEqual({
      kind: 'raw',
      text: `event-${AI_RUN_EVENT_HEAD_LIMIT + 1}`,
    })
    expect(record.events[record.events.length - 1]).toEqual({
      kind: 'raw',
      text: `event-${capacity}`,
    })
  })

  test('writes the log with the task name captured at start even after a mid-run rename', async () => {
    const harness = createHarness()
    const file = makeTaskFile('TaskChute/Task/Original Name.md', 'Original Name')
    const record = await harness.manager.startRun(file)

    // Obsidian mutates the same TFile object in place on rename; a deleted
    // note behaves the same way from the record's point of view (the record
    // must not reach back into the file at exit time).
    file.path = 'TaskChute/Task/Renamed Later.md'
    file.basename = 'Renamed Later'

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: 'Original Name',
        taskPath: 'TaskChute/Task/Original Name.md',
      }),
    )
    expect(record.taskName).toBe('Original Name')
  })

  test('maps a clean exit to succeeded', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })

    expect(record.status).toBe('succeeded')
    expect(record.exitCode).toBe(0)
    expect(record.endedAt).toBeDefined()
  })

  test('maps a failing exit to failed with the error message', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.claude.last.exit({
      status: 'failed',
      exitCode: 1,
      signal: null,
      errorMessage: 'Process exited with code 1',
    })

    expect(record.status).toBe('failed')
    expect(record.exitCode).toBe(1)
    expect(record.errorMessage).toBe('Process exited with code 1')
  })

  test('stopRun marks the run stopping and stops the process', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.stopRun(record.id)

    expect(record.status).toBe('stopping')
    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)

    harness.claude.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    expect(record.status).toBe('stopped')
  })

  test('stopRun is a no-op for unknown or finished runs', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })

    harness.manager.stopRun('missing-id')
    harness.manager.stopRun(record.id)

    expect(harness.claude.last.stop).not.toHaveBeenCalled()
    expect(record.status).toBe('succeeded')
  })

  test('renderer transition waits for headless force-kill escalation without disposing', async () => {
    const harness = createHarness()
    await harness.manager.startRun(makeTaskFile())

    const completion =
      harness.manager.stopNonPersistentRunsForRendererTransitionAndWait()

    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)
    expect(harness.claude.last.forceKill).not.toHaveBeenCalled()
    expect(harness.manager.isDisposed()).toBe(false)
    expect(harness.timer.scheduled).toHaveLength(1)
    expect(harness.timer.scheduled[0]?.timeoutMs).toBe(DISPOSE_FORCE_KILL_MS)

    harness.timer.fireAll()
    await completion

    expect(harness.claude.last.forceKill).toHaveBeenCalledTimes(1)
    expect(harness.manager.isDisposed()).toBe(false)
  })

  test('renderer transition resolves early when every headless process exits', async () => {
    const harness = createHarness()
    await harness.manager.startRun(makeTaskFile())

    const completion =
      harness.manager.stopNonPersistentRunsForRendererTransitionAndWait()
    harness.claude.last.exit({
      status: 'stopped',
      exitCode: null,
      signal: 'SIGTERM',
    })
    await completion

    expect(harness.claude.last.forceKill).not.toHaveBeenCalled()
    expect(harness.timer.cleared).toEqual([
      harness.timer.scheduled[0]?.handle,
    ])
  })

  test('writes the run log and prunes old logs after exit', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    expect(harness.writeRunLog).not.toHaveBeenCalled()

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeRunLog).toHaveBeenCalledWith(record)
    expect(harness.pruneOldLogs).toHaveBeenCalledTimes(1)
  })

  test('survives log writer failures', async () => {
    const harness = createHarness()
    harness.writeRunLog.mockRejectedValueOnce(new Error('disk full'))
    const record = await harness.manager.startRun(makeTaskFile())

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(record.status).toBe('succeeded')
    expect(harness.pruneOldLogs).toHaveBeenCalledTimes(1)
  })
})

describe('AiTaskManager.dispose', () => {
  test('stops all active runs and escalates with a force kill timer', async () => {
    const harness = createHarness()
    await harness.manager.startRun(makeTaskFile('TaskChute/Task/A.md', 'A'))
    await harness.manager.startRun(makeTaskFile('TaskChute/Task/B.md', 'B'))
    const [first, second] = harness.claude.runs

    harness.manager.dispose()

    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(second.stop).toHaveBeenCalledTimes(1)
    expect(harness.timer.scheduled).toHaveLength(1)
    expect(harness.timer.scheduled[0].timeoutMs).toBe(DISPOSE_FORCE_KILL_MS)
    expect(first.forceKill).not.toHaveBeenCalled()

    harness.timer.fireAll()
    expect(first.forceKill).toHaveBeenCalledTimes(1)
    expect(second.forceKill).toHaveBeenCalledTimes(1)
  })

  test('default force-kill deadline survives a focused popout closing', async () => {
    const originalActiveWindow = activeWindow
    const focusedPopout = {
      setTimeout: jest.fn(() => 999),
      clearTimeout: jest.fn(),
    } as unknown as Window
    const replacementPopout = {
      setTimeout: jest.fn(() => 1000),
      clearTimeout: jest.fn(),
    } as unknown as Window
    jest.useFakeTimers()

    try {
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        focusedPopout
      const harness = createHarness({ useDefaultTimer: true })
      await harness.manager.startRun(makeTaskFile())
      const run = harness.claude.last

      harness.manager.dispose()
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        replacementPopout

      expect(run.stop).toHaveBeenCalledTimes(1)
      expect(focusedPopout.setTimeout).not.toHaveBeenCalled()
      expect(replacementPopout.setTimeout).not.toHaveBeenCalled()

      jest.advanceTimersByTime(DISPOSE_FORCE_KILL_MS)

      expect(run.forceKill).toHaveBeenCalledTimes(1)
    } finally {
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        originalActiveWindow
      jest.useRealTimers()
    }
  })

  test('is idempotent and clears listeners', async () => {
    const harness = createHarness()
    const listener = jest.fn()
    harness.manager.onChange(listener)
    await harness.manager.startRun(makeTaskFile())
    const run = harness.claude.last
    const callsBefore = listener.mock.calls.length

    harness.manager.dispose()
    harness.manager.dispose()

    expect(run.stop).toHaveBeenCalledTimes(1)

    run.emit({ kind: 'assistant-text', text: 'zombie output' })
    expect(listener.mock.calls.length).toBe(callsBefore)
  })

  test('does not schedule a force kill without active runs', () => {
    const harness = createHarness()

    harness.manager.dispose()

    expect(harness.timer.scheduled).toHaveLength(0)
  })

  test('rejects startRun on an already disposed manager without touching the note', async () => {
    const harness = createHarness()

    harness.manager.dispose()

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiTaskManagerDisposedError,
    )
    expect(harness.resolve).not.toHaveBeenCalled()
    expect(harness.claude.runs).toHaveLength(0)
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('aborts an in-flight start when dispose happens while reading the note', async () => {
    let resolveRead: (content: string) => void = () => undefined
    const harness = createHarness({
      cachedRead: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    })

    const startPromise = harness.manager.startRun(makeTaskFile())
    harness.manager.dispose()
    resolveRead('# Task\n\n## Prompt\n\nDo the thing\n')

    await expect(startPromise).rejects.toBeInstanceOf(AiTaskManagerDisposedError)
    expect(harness.resolve).not.toHaveBeenCalled()
    expect(harness.claude.runs).toHaveLength(0)
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('does not dispatch when dispose happens during binary resolution', async () => {
    let resolveBinary: (path: string) => void = () => undefined
    const harness = createHarness({
      resolveBinary: () =>
        new Promise<string>((resolve) => {
          resolveBinary = resolve
        }),
    })

    const startPromise = harness.manager.startRun(makeTaskFile())
    await flushPromises()
    expect(harness.resolve).toHaveBeenCalledTimes(1)

    harness.manager.dispose()
    resolveBinary('/bin/claude')

    await expect(startPromise).rejects.toBeInstanceOf(AiTaskManagerDisposedError)
    expect(harness.claude.runs).toHaveLength(0)
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('skips log writing for exits that arrive after dispose', async () => {
    const harness = createHarness()
    await harness.manager.startRun(makeTaskFile())
    const run = harness.claude.last

    harness.manager.dispose()
    run.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()

    expect(harness.writeRunLog).not.toHaveBeenCalled()
  })
})

describe('AiTaskManager session id capture', () => {
  test('stores the session id from the init event on the record', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.sessionId).toBeUndefined()
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1', model: 'm' })

    expect(record.sessionId).toBe('sess-1')
  })

  test('a later init event overwrites the stored session id', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-2' })

    expect(record.sessionId).toBe('sess-2')
  })

  test('init events without a session id leave the stored one intact', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })
    harness.claude.last.emit({ kind: 'init', model: 'model-only' })

    expect(record.sessionId).toBe('sess-1')
  })
})

describe('AiTaskManager.followUp', () => {
  async function startFinishedRun(
    harness: ReturnType<typeof createHarness>,
    options: { sessionId?: string | null; status?: 'succeeded' | 'failed' | 'stopped' } = {},
  ) {
    const record = await harness.manager.startRun(makeTaskFile())
    if (options.sessionId !== null) {
      harness.claude.last.emit({
        kind: 'init',
        sessionId: options.sessionId ?? 'sess-1',
      })
    }
    const status = options.status ?? 'succeeded'
    harness.claude.last.exit({
      status,
      exitCode: status === 'succeeded' ? 0 : null,
      signal: status === 'stopped' ? 'SIGTERM' : null,
    })
    await flushPromises()
    return record
  }

  test('dispatches a resume run and appends the user text to the same record', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_args: '--max-turns 1' },
    })
    const record = await startFinishedRun(harness)
    const statuses: string[] = []
    harness.manager.onChange((changed) => statuses.push(changed.status))

    const result = await harness.manager.followUp(record.id, 'continue please')

    expect(result).toBe(record)
    expect(harness.claude.runs).toHaveLength(2)
    expect(harness.claude.last.request).toEqual({
      binaryPath: '/bin/claude',
      prompt: 'continue please',
      cwd: '/vault/base',
      extraArgs: ['--max-turns', '1'],
      resumeSessionId: 'sess-1',
    })
    expect(record.events).toContainEqual({ kind: 'user-text', text: 'continue please' })
    expect(statuses).toEqual(['starting', 'running'])
    expect(record.status).toBe('running')
    expect(record.endedAt).toBeUndefined()
    expect(typeof record.resumedAt).toBe('number')
    // The manager still reports one single run for the task.
    expect(harness.manager.getRuns()).toEqual([record])
    expect(harness.manager.getActiveRunForTask(record.taskPath)).toBe(record)
  })

  test('retries a missing follow-up executable once without duplicating user text', async () => {
    const harness = createHarness({
      resolveBinary: async (_host, options) =>
        options?.forceRefresh ? '/bin/claude-v2' : '/bin/claude-v1',
    })
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue once')
    harness.claude.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'spawn ENOENT',
      launchError: { code: 'ENOENT', message: 'spawn ENOENT' },
    })
    await flushPromises()

    expect(harness.claude.runs).toHaveLength(3)
    expect(harness.claude.last.request).toMatchObject({
      binaryPath: '/bin/claude-v2',
      prompt: 'continue once',
      resumeSessionId: 'sess-1',
    })
    expect(
      record.events.filter(
        (event) => event.kind === 'user-text' && event.text === 'continue once',
      ),
    ).toHaveLength(1)
    expect(record.status).toBe('running')
  })

  test('follow-up stream events append to the record and exit remaps the status', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue')
    harness.claude.last.emit({ kind: 'assistant-text', text: 'more output' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(record.events).toContainEqual({ kind: 'assistant-text', text: 'more output' })
    expect(record.status).toBe('succeeded')
    expect(record.exitCode).toBe(0)
    expect(record.endedAt).toBeDefined()
  })

  test('rewrites the same log note via the upsert path', async () => {
    const harness = createHarness({ withUpsert: true })
    const record = await startFinishedRun(harness)

    expect(harness.upsertRunLog).toHaveBeenCalledTimes(1)
    // The initial run end persists the full record; there is no continuation.
    expect(harness.upsertRunLog.mock.calls[0][1]).toBeUndefined()
    expect(harness.writeRunLog).not.toHaveBeenCalled()
    expect(record.logNotePath).toBe('upsert-log-path.md')

    await harness.manager.followUp(record.id, 'continue')
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.upsertRunLog).toHaveBeenCalledTimes(2)
    expect(harness.upsertRunLog).toHaveBeenLastCalledWith(record, [
      { kind: 'user-text', text: 'continue' },
    ])
    // The record still points at the original note before the second upsert
    // resolves a path, so the writer can modify it in place.
    expect(record.logNotePath).toBe('upsert-log-path.md')
  })

  test('passes only the post-follow-up events to the upsert path (no re-elided history)', async () => {
    const harness = createHarness({ withUpsert: true })
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue')
    harness.claude.last.emit({ kind: 'assistant-text', text: 'more output' })
    harness.claude.last.emit({ kind: 'stderr', text: 'warn: minor' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    const [, continuation] = harness.upsertRunLog.mock.calls[1]
    expect(continuation).toEqual([
      { kind: 'user-text', text: 'continue' },
      { kind: 'assistant-text', text: 'more output' },
      { kind: 'stderr', text: 'warn: minor' },
    ])
  })

  test('a second follow-up passes only its own continuation segment', async () => {
    const harness = createHarness({ withUpsert: true })
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'first')
    harness.claude.last.emit({ kind: 'assistant-text', text: 'answer one' })
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-2' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    await harness.manager.followUp(record.id, 'second')
    harness.claude.last.emit({ kind: 'assistant-text', text: 'answer two' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    const [, continuation] = harness.upsertRunLog.mock.calls[2]
    expect(continuation).toEqual([
      { kind: 'user-text', text: 'second' },
      { kind: 'assistant-text', text: 'answer two' },
    ])
  })

  test('removes the user-text event when the resume dispatch fails, so a retry does not duplicate it', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)
    harness.claude.failNextStart = new Error('spawn failed')

    await expect(harness.manager.followUp(record.id, 'continue')).rejects.toThrow(
      'spawn failed',
    )

    expect(
      record.events.filter((event) => event.kind === 'user-text'),
    ).toHaveLength(0)

    await harness.manager.followUp(record.id, 'continue')
    harness.claude.last.emit({ kind: 'assistant-text', text: 'retry output' })

    expect(record.events.filter((event) => event.kind === 'user-text')).toEqual([
      { kind: 'user-text', text: 'continue' },
    ])
  })

  test('rejects a follow-up while the run is still active', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })

    await expect(
      harness.manager.followUp(record.id, 'too early'),
    ).rejects.toBeInstanceOf(AiRunAlreadyActiveError)
    expect(harness.claude.runs).toHaveLength(1)
    expect(record.events).not.toContainEqual({ kind: 'user-text', text: 'too early' })
  })

  test('rejects a duplicate follow-up while the first one is running', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'first follow-up')
    await expect(
      harness.manager.followUp(record.id, 'second follow-up'),
    ).rejects.toBeInstanceOf(AiRunAlreadyActiveError)
    expect(harness.claude.runs).toHaveLength(2)
  })

  test('rejects concurrent duplicate follow-ups before dispatch', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    const results = await Promise.allSettled([
      harness.manager.followUp(record.id, 'one'),
      harness.manager.followUp(record.id, 'two'),
    ])

    const fulfilled = results.filter((entry) => entry.status === 'fulfilled')
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(AiRunAlreadyActiveError)
    expect(harness.claude.runs).toHaveLength(2)
  })

  test('rejects when the run has no session id', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness, { sessionId: null })

    await expect(
      harness.manager.followUp(record.id, 'continue'),
    ).rejects.toBeInstanceOf(AiSessionUnavailableError)
    expect(harness.claude.runs).toHaveLength(1)
    expect(record.status).toBe('succeeded')
  })

  test('rejects unknown run ids', async () => {
    const harness = createHarness()

    await expect(
      harness.manager.followUp('missing-run', 'continue'),
    ).rejects.toBeInstanceOf(AiRunNotFoundError)
  })

  test('rejects blank prompts without touching the record', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await expect(harness.manager.followUp(record.id, '   ')).rejects.toBeInstanceOf(Error)
    expect(harness.claude.runs).toHaveLength(1)
    expect(record.status).toBe('succeeded')
  })

  test('allows follow-ups on failed and stopped runs', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness, { status: 'failed' })

    await harness.manager.followUp(record.id, 'try again')

    expect(record.status).toBe('running')
    expect(harness.claude.runs).toHaveLength(2)
  })

  test('keeps the run finished when the binary cannot be resolved', async () => {
    let calls = 0
    const harness = createHarness({
      resolveBinary: () => {
        calls += 1
        if (calls === 1) return Promise.resolve('/bin/claude')
        return Promise.reject(new Error('binary gone'))
      },
    })
    const record = await startFinishedRun(harness)

    await expect(harness.manager.followUp(record.id, 'continue')).rejects.toThrow(
      'binary gone',
    )
    expect(record.status).toBe('succeeded')
    expect(record.events).not.toContainEqual({ kind: 'user-text', text: 'continue' })
    expect(harness.claude.runs).toHaveLength(1)
    // A later follow-up can still proceed once the binary is back.
    expect(harness.manager.getActiveRunForTask(record.taskPath)).toBeUndefined()
  })

  test('stopRun stops a follow-up process', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue')
    harness.manager.stopRun(record.id)

    expect(record.status).toBe('stopping')
    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)

    harness.claude.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    expect(record.status).toBe('stopped')
  })

  test('rejects follow-ups after dispose', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    harness.manager.dispose()

    await expect(
      harness.manager.followUp(record.id, 'continue'),
    ).rejects.toBeInstanceOf(AiTaskManagerDisposedError)
  })

  test('rejects when the run is released while awaiting the pending persist, without dispatching', async () => {
    // Carried BLOCKING regression: the composer enables as soon as the run
    // finishes, but the exit persist may still be pending. Closing the run's
    // tab in that window releases the record; a follow-up that already
    // parked on the persist queue must then reject instead of resuming on
    // the stale InternalRun (whose child no other code path could ever
    // stop or kill again).
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })

    // Hold the exit persist open so followUp awaits a pending queue.
    let resolvePersist: (path: string) => void = () => undefined
    harness.writeRunLog.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolvePersist = resolve
        }),
    )
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })

    // Mirror the pane: the finished run's view closes on 'persisted' and
    // releases the record from the manager.
    harness.manager.onChange((changed, changeType) => {
      if (changeType === 'persisted') harness.manager.releaseRun(changed.id)
    })

    const followUp = harness.manager.followUp(record.id, 'continue')
    const rejection = expect(followUp).rejects.toBeInstanceOf(AiRunNotFoundError)
    // Let the persist chain reach the (held-open) writeRunLog call, then
    // complete it — 'persisted' fires and the listener releases the run.
    await flushPromises()
    resolvePersist('log-path.md')
    await rejection

    // No resume child was dispatched on the released record...
    expect(harness.claude.runs).toHaveLength(1)
    // ...and the record kept its finished state (no optimistic mutation).
    expect(record.status).toBe('succeeded')
    expect(record.events).not.toContainEqual({ kind: 'user-text', text: 'continue' })
    expect(harness.manager.getRun(record.id)).toBeUndefined()
  })

  test('rejects when the run is released during binary resolution, without dispatching', async () => {
    let resolveBinary: ((path: string) => void) | null = null
    let calls = 0
    const harness = createHarness({
      resolveBinary: () => {
        calls += 1
        if (calls === 1) return Promise.resolve('/bin/claude')
        return new Promise<string>((resolve) => {
          resolveBinary = resolve
        })
      },
    })
    const record = await startFinishedRun(harness)

    const followUp = harness.manager.followUp(record.id, 'continue')
    const rejection = expect(followUp).rejects.toBeInstanceOf(AiRunNotFoundError)
    // Let followUp pass the (settled) persist queue and park on the binary.
    await flushPromises()
    harness.manager.releaseRun(record.id)
    resolveBinary?.('/bin/claude')
    await rejection

    expect(harness.claude.runs).toHaveLength(1)
    expect(record.status).toBe('succeeded')
    expect(record.events).not.toContainEqual({ kind: 'user-text', text: 'continue' })
  })

  test('blocks startRun for the task while a follow-up is active', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue')

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )
  })
})

describe('AiTaskManager.requestStopForTask', () => {
  const TASK_PATH = 'TaskChute/Task/My Task.md'

  test('stops the active run for the task', async () => {
    const harness = createHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.requestStopForTask(TASK_PATH)

    expect(record.status).toBe('stopping')
    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)
  })

  test('queues the stop while a start is in flight and terminates the run right after dispatch', async () => {
    let releaseBinary!: () => void
    const harness = createHarness({
      resolveBinary: () =>
        new Promise<string>((resolve) => {
          releaseBinary = () => resolve('/bin/claude')
        }),
    })

    const startPromise = harness.manager.startRun(makeTaskFile())
    await flushPromises()
    // The run is not registered yet: this is the async window where a plain
    // stopRun/getActiveRunForTask coupling would silently lose the stop.
    expect(harness.manager.getActiveRunForTask(TASK_PATH)).toBeUndefined()

    harness.manager.requestStopForTask(TASK_PATH)
    releaseBinary()
    const record = await startPromise

    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)
    expect(record.status).toBe('stopping')

    harness.claude.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    expect(record.status).toBe('stopped')
  })

  test('is a no-op without an active run or pending start and does not poison later runs', async () => {
    const harness = createHarness()

    harness.manager.requestStopForTask(TASK_PATH)
    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.status).toBe('running')
    expect(harness.claude.last.stop).not.toHaveBeenCalled()
  })

  test('clears a queued stop when the in-flight start fails, leaving the next run untouched', async () => {
    let failNext = true
    let releaseBinary!: () => void
    const harness = createHarness({
      resolveBinary: () => {
        if (failNext) {
          return new Promise<string>((_, reject) => {
            releaseBinary = () => reject(new Error('binary missing'))
          })
        }
        return Promise.resolve('/bin/claude')
      },
    })

    const failing = harness.manager.startRun(makeTaskFile())
    await flushPromises()
    harness.manager.requestStopForTask(TASK_PATH)
    releaseBinary()
    await expect(failing).rejects.toThrow('binary missing')

    failNext = false
    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.status).toBe('running')
    expect(harness.claude.last.stop).not.toHaveBeenCalled()
  })

  test('a queued stop during an in-flight follow-up terminates the resumed run', async () => {
    let deferBinary = false
    let releaseBinary!: () => void
    const harness = createHarness({
      resolveBinary: () => {
        if (deferBinary) {
          return new Promise<string>((resolve) => {
            releaseBinary = () => resolve('/bin/claude')
          })
        }
        return Promise.resolve('/bin/claude')
      },
    })
    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    deferBinary = true
    const followUpPromise = harness.manager.followUp(record.id, 'continue')
    await flushPromises()
    harness.manager.requestStopForTask(TASK_PATH)
    releaseBinary()
    await followUpPromise

    expect(harness.claude.runs).toHaveLength(2)
    expect(harness.claude.last.stop).toHaveBeenCalledTimes(1)
    expect(record.status).toBe('stopping')
  })
})

describe('AiTaskManager log persistence serialization', () => {
  test('followUp waits for the pending persist, so the note gets the finished status and no duplicate is created', async () => {
    const harness = createHarness({ withUpsert: true })
    const statusesAtWrite: string[] = []
    let releaseUpsert!: () => void
    harness.upsertRunLog.mockImplementationOnce(async (rec) => {
      await new Promise<void>((resolve) => {
        releaseUpsert = resolve
      })
      // Sampled after the async gap, like composeFrontmatter inside the real
      // writer: a follow-up dispatched meanwhile would leak transient
      // starting/running frontmatter into the persisted note.
      statusesAtWrite.push(rec.status)
      return 'first-note.md'
    })

    const record = await harness.manager.startRun(makeTaskFile())
    harness.claude.last.emit({ kind: 'init', sessionId: 'sess-1' })
    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()
    // First persist still pending.
    expect(record.logNotePath).toBeUndefined()

    const followUpPromise = harness.manager.followUp(record.id, 'continue')
    await flushPromises()
    // The resume must not dispatch while the persist is in flight.
    expect(harness.claude.runs).toHaveLength(1)
    expect(record.status).toBe('succeeded')

    releaseUpsert()
    await followUpPromise

    expect(statusesAtWrite).toEqual(['succeeded'])
    expect(record.logNotePath).toBe('first-note.md')
    expect(harness.claude.runs).toHaveLength(2)
    expect(harness.claude.last.request).toMatchObject({ resumeSessionId: 'sess-1' })

    harness.claude.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    // Both persists went through the upsert path against the same record;
    // the fallback create path was never used, so no duplicate note.
    expect(harness.upsertRunLog).toHaveBeenCalledTimes(2)
    expect(harness.writeRunLog).not.toHaveBeenCalled()
  })
})
