/**
 * AiTaskManager 'persisted' change notification:
 *   - every run exit ends its persist chain with an onChange notification of
 *     changeType 'persisted' (terminal AND headless runs), fired only AFTER
 *     the log write + prune completed
 *   - regular status/event notifications carry changeType 'update'
 *   - for terminal runs the snapshot provider is consulted BEFORE the
 *     'persisted' notification, so a listener that tears down the terminal
 *     view on 'persisted' can never starve the log note of its transcript
 */
import { TFile } from 'obsidian'
import {
  AiTaskManager,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiDispatcher,
  AiRunCallbacks,
  AiRunExitOutcome,
  AiRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type {
  AiTerminalDispatcher,
  TerminalRunCallbacks,
  TerminalRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

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

interface FakeHeadlessRun {
  request: AiRunRequest
  callbacks: AiRunCallbacks
  exit(outcome: AiRunExitOutcome): void
}

class FakeHeadlessDispatcher implements AiDispatcher {
  runs: FakeHeadlessRun[] = []
  /** When set, the next start() throws this error (spawn failure) */
  failNextStart: Error | null = null

  start(request: AiRunRequest, callbacks: AiRunCallbacks) {
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = null
      throw error
    }
    const run: FakeHeadlessRun = {
      request,
      callbacks,
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return { pid: 1111, stop: jest.fn() }
  }
}

interface FakeTerminalRun {
  request: TerminalRunRequest
  callbacks: TerminalRunCallbacks
  exit(outcome: AiRunExitOutcome): void
}

class FakeTerminalDispatcher implements AiTerminalDispatcher {
  runs: FakeTerminalRun[] = []
  /** When set, the next start() throws this error (spawn failure) */
  failNextStart: Error | null = null

  start(request: TerminalRunRequest, callbacks: TerminalRunCallbacks) {
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = null
      throw error
    }
    const run: FakeTerminalRun = {
      request,
      callbacks,
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return { pid: 2222, write: jest.fn(), stop: jest.fn(), forceKill: jest.fn() }
  }

  get last(): FakeTerminalRun {
    if (this.runs.length === 0) throw new Error('No terminal run started')
    return this.runs[this.runs.length - 1]
  }
}

interface HarnessOptions {
  runMode?: 'terminal' | 'headless'
  /** Deferred terminal log write: the test resolves it manually */
  deferTerminalWrite?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const headless = new FakeHeadlessDispatcher()
  const terminal = new FakeTerminalDispatcher()
  let resolveTerminalWrite: (() => void) | null = null
  const writeRunLog = jest.fn<Promise<string>, [AiRunRecord]>(
    async () => 'headless-log.md',
  )
  const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
    () => {
      if (!options.deferTerminalWrite) return Promise.resolve('terminal-log.md')
      return new Promise((resolve) => {
        resolveTerminalWrite = () => resolve('terminal-log.md')
      })
    },
  )
  const pruneOldLogs = jest.fn(async () => undefined)

  const deps: AiTaskManagerDeps = {
    app: {
      vault: {
        cachedRead: jest.fn(async () => '# Task\n\n## Prompt\n\nDo the thing\n'),
        adapter: { getBasePath: () => '/vault/base' },
      },
      metadataCache: {
        getFileCache: jest.fn(() => ({ frontmatter: { ai_task: true } })),
      },
    },
    dispatchers: { claude: headless, codex: headless },
    binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
    logWriter: { writeRunLog, writeTerminalRunLog, pruneOldLogs },
    terminal: {
      dispatcher: terminal,
      isSupported: () => true,
      makeTempFilePath: (prefix: string) => `/tmp/fake-transcripts/${prefix}.log`,
      readAndDeleteFile: jest.fn(async () => 'transcript body'),
    },
    getRunMode: () => options.runMode ?? 'terminal',
  }

  return {
    manager: new AiTaskManager(deps),
    headless,
    terminal,
    writeRunLog,
    writeTerminalRunLog,
    pruneOldLogs,
    releaseTerminalWrite: () => {
      resolveTerminalWrite?.()
      resolveTerminalWrite = null
    },
  }
}

describe("AiTaskManager 'persisted' notifications", () => {
  test("a stopped terminal run fires 'persisted' after the log write, with the snapshot consulted first", async () => {
    const harness = createHarness()
    const order: string[] = []
    harness.manager.registerTerminalSnapshotProvider(() => {
      order.push('snapshot')
      return 'terminal screen text'
    })
    harness.manager.onChange((record, changeType) => {
      order.push(`${changeType}:${record.status}`)
    })

    await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: null })
    await flushPromises()

    // The final status notification is a plain update; the snapshot is
    // consulted afterwards, and only then does 'persisted' fire.
    expect(order).toContain('update:stopped')
    expect(order).toContain('persisted:stopped')
    expect(order.indexOf('update:stopped')).toBeLessThan(order.indexOf('snapshot'))
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('persisted:stopped'))
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeTerminalRunLog.mock.calls[0][1]).toBe('terminal screen text')
  })

  test("'persisted' does not fire before the log write settles", async () => {
    const harness = createHarness({ deferTerminalWrite: true })
    const changeTypes: string[] = []
    harness.manager.onChange((_record, changeType) => {
      changeTypes.push(changeType)
    })

    await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: null })
    await flushPromises()

    expect(changeTypes).not.toContain('persisted')

    harness.releaseTerminalWrite()
    await flushPromises()

    expect(changeTypes).toContain('persisted')
    expect(harness.pruneOldLogs).toHaveBeenCalledTimes(1)
  })

  test("succeeded terminal runs also fire 'persisted'", async () => {
    const harness = createHarness()
    const notifications: Array<{ changeType: string; status: string }> = []
    harness.manager.onChange((record, changeType) => {
      notifications.push({ changeType, status: record.status })
    })

    await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(notifications).toContainEqual({
      changeType: 'persisted',
      status: 'succeeded',
    })
  })

  test("headless runs fire 'persisted' at the end of their persist chain", async () => {
    const harness = createHarness({ runMode: 'headless' })
    const order: string[] = []
    harness.manager.onChange((record, changeType) => {
      order.push(`${changeType}:${record.status}`)
    })
    harness.writeRunLog.mockImplementation(async () => {
      order.push('write')
      return 'headless-log.md'
    })

    await harness.manager.startRun(makeTaskFile())
    harness.headless.runs[0].exit({ status: 'stopped', exitCode: null, signal: null })
    await flushPromises()

    expect(order).toContain('persisted:stopped')
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('persisted:stopped'))
  })

  test("regular status notifications carry changeType 'update'", async () => {
    const harness = createHarness({ runMode: 'headless' })
    const changeTypes: string[] = []
    harness.manager.onChange((_record, changeType) => {
      changeTypes.push(changeType)
    })

    await harness.manager.startRun(makeTaskFile())

    expect(changeTypes.length).toBeGreaterThan(0)
    expect(new Set(changeTypes)).toEqual(new Set(['update']))
  })
})

describe("dispatch failures also end with 'persisted'", () => {
  test("a headless dispatcher that throws at start still fires 'persisted' once, after a minimal log note", async () => {
    const harness = createHarness({ runMode: 'headless' })
    // Recoverable OS launch errors are retried once. Use an unrecoverable
    // dispatcher/configuration error here to exercise the immediate failure
    // persistence contract this test owns.
    harness.headless.failNextStart = new Error('invalid launch configuration')
    const order: string[] = []
    harness.manager.onChange((record, changeType) => {
      order.push(`${changeType}:${record.status}`)
    })
    harness.writeRunLog.mockImplementation(async () => {
      order.push('write')
      return 'headless-log.md'
    })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toThrow(
      'invalid launch configuration',
    )
    await flushPromises()

    expect(order.filter((entry) => entry === 'persisted:failed')).toHaveLength(1)
    expect(harness.writeRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeRunLog.mock.calls[0][0].status).toBe('failed')
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('persisted:failed'))
    expect(harness.pruneOldLogs).toHaveBeenCalledTimes(1)
  })

  test("a terminal dispatcher that throws at start fires 'persisted' and still consumes the transcript temp file", async () => {
    const harness = createHarness()
    harness.terminal.failNextStart = new Error('script missing')
    const changeTypes: string[] = []
    harness.manager.onChange((_record, changeType) => {
      changeTypes.push(changeType)
    })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toThrow(
      'script missing',
    )
    await flushPromises()

    expect(changeTypes.filter((type) => type === 'persisted')).toHaveLength(1)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeTerminalRunLog.mock.calls[0][0].status).toBe('failed')
  })

  test("a follow-up dispatch failure ends its segment with 'persisted' too", async () => {
    const harness = createHarness({ runMode: 'headless' })
    const persistedStatuses: string[] = []
    harness.manager.onChange((record, changeType) => {
      if (changeType === 'persisted') persistedStatuses.push(record.status)
    })

    const record = await harness.manager.startRun(makeTaskFile())
    harness.headless.runs[0].callbacks.onEvent({
      kind: 'init',
      sessionId: 'sess-1',
    })
    harness.headless.runs[0].exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()
    expect(persistedStatuses).toEqual(['succeeded'])

    harness.headless.failNextStart = new Error('resume failed')
    await expect(harness.manager.followUp(record.id, 'more')).rejects.toThrow(
      'resume failed',
    )
    await flushPromises()

    expect(persistedStatuses).toEqual(['succeeded', 'failed'])
    expect(harness.writeRunLog).toHaveBeenCalledTimes(2)
  })
})
