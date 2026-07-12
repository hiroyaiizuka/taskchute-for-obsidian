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
  resolveBinary?: (host: string) => Promise<string>
  cachedRead?: () => Promise<string>
  /** When true, the log writer also exposes the upsert path used for rewrites */
  withUpsert?: boolean
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
    binaryLocator: { resolve },
    logWriter: options.withUpsert
      ? { writeRunLog, upsertRunLog, pruneOldLogs }
      : { writeRunLog, pruneOldLogs },
    timer,
  }

  return {
    manager: new AiTaskManager(deps),
    claude,
    codex,
    timer,
    writeRunLog,
    upsertRunLog,
    pruneOldLogs,
    resolve,
  }
}

describe('AiTaskManager.startRun', () => {
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

  test('keeps an absolute ai_task_cwd as-is', async () => {
    const harness = createHarness({
      frontmatter: { ai_task: true, ai_task_cwd: '/absolute/dir' },
    })

    await harness.manager.startRun(makeTaskFile())

    expect(harness.claude.last.request.cwd).toBe('/absolute/dir')
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
    expect(listener).toHaveBeenLastCalledWith(record)
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

  test('blocks startRun for the task while a follow-up is active', async () => {
    const harness = createHarness()
    const record = await startFinishedRun(harness)

    await harness.manager.followUp(record.id, 'continue')

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiRunAlreadyActiveError,
    )
  })
})
