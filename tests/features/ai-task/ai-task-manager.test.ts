import { TFile } from 'obsidian'
import {
  AiTaskManager,
  AiPromptNotFoundError,
  AiRunAlreadyActiveError,
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
import type { AiStreamEvent } from '../../../src/features/ai-task/types'

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

  start(request: AiRunRequest, callbacks: AiRunCallbacks) {
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
}

function createHarness(options: HarnessOptions = {}) {
  const claude = new FakeDispatcher()
  const codex = new FakeDispatcher()
  const timer = createFiringTimer()
  const writeRunLog = jest.fn(async () => 'log-path.md')
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
    logWriter: { writeRunLog, pruneOldLogs },
    timer,
  }

  return {
    manager: new AiTaskManager(deps),
    claude,
    codex,
    timer,
    writeRunLog,
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
