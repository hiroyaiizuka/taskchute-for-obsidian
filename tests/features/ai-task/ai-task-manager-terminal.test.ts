import { TFile } from 'obsidian'
import {
  AiTaskManager,
  AiTerminalFollowUpError,
  TERMINAL_DATA_BUFFER_LIMIT,
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

interface FakeHeadlessRun {
  request: AiRunRequest
  callbacks: AiRunCallbacks
  stop: jest.Mock
  emit(event: AiStreamEvent): void
  exit(outcome: AiRunExitOutcome): void
}

class FakeHeadlessDispatcher implements AiDispatcher {
  runs: FakeHeadlessRun[] = []

  start(request: AiRunRequest, callbacks: AiRunCallbacks) {
    const run: FakeHeadlessRun = {
      request,
      callbacks,
      stop: jest.fn(),
      emit: (event) => callbacks.onEvent(event),
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return { pid: 1111, stop: run.stop }
  }
}

interface FakeTerminalRun {
  request: TerminalRunRequest
  callbacks: TerminalRunCallbacks
  write: jest.Mock
  stop: jest.Mock
  forceKill: jest.Mock
  emitData(chunk: string): void
  exit(outcome: AiRunExitOutcome): void
}

class FakeTerminalDispatcher implements AiTerminalDispatcher {
  runs: FakeTerminalRun[] = []
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
      write: jest.fn(),
      stop: jest.fn(),
      forceKill: jest.fn(),
      emitData: (chunk) => callbacks.onData(chunk),
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return { pid: 2222, write: run.write, stop: run.stop, forceKill: run.forceKill }
  }

  get last(): FakeTerminalRun {
    if (this.runs.length === 0) throw new Error('No terminal run started')
    return this.runs[this.runs.length - 1]
  }
}

interface HarnessOptions {
  runMode?: 'terminal' | 'headless'
  supported?: boolean
  transcriptContent?: string
  withTerminalWriter?: boolean
  frontmatter?: Record<string, unknown>
}

function createTerminalHarness(options: HarnessOptions = {}) {
  const headless = new FakeHeadlessDispatcher()
  const terminal = new FakeTerminalDispatcher()
  const writeRunLog = jest.fn(async () => 'headless-log.md')
  const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
    async () => 'terminal-log.md',
  )
  const pruneOldLogs = jest.fn(async () => undefined)
  const makeTempFilePath = jest.fn(
    (prefix: string) => `/tmp/fake-transcripts/${prefix}.log`,
  )
  const readAndDeleteFile = jest.fn(async () =>
    options.transcriptContent ?? 'transcript body',
  )
  const isSupported = jest.fn(() => options.supported ?? true)
  const getRunMode = jest.fn(() => options.runMode ?? 'terminal')
  const withTerminalWriter = options.withTerminalWriter ?? true

  const deps: AiTaskManagerDeps = {
    app: {
      vault: {
        cachedRead: jest.fn(async () => '# Task\n\n## Prompt\n\nDo the thing\n'),
        adapter: { getBasePath: () => '/vault/base' },
      },
      metadataCache: {
        getFileCache: jest.fn(() => ({
          frontmatter: options.frontmatter ?? { ai_task: true },
        })),
      },
    },
    dispatchers: { claude: headless, codex: headless },
    binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
    logWriter: withTerminalWriter
      ? { writeRunLog, writeTerminalRunLog, pruneOldLogs }
      : { writeRunLog, pruneOldLogs },
    terminal: {
      dispatcher: terminal,
      isSupported,
      makeTempFilePath,
      readAndDeleteFile,
    },
    getRunMode,
  }

  return {
    manager: new AiTaskManager(deps),
    headless,
    terminal,
    writeRunLog,
    writeTerminalRunLog,
    pruneOldLogs,
    makeTempFilePath,
    readAndDeleteFile,
    isSupported,
    getRunMode,
  }
}

describe('AiTaskManager terminal mode routing', () => {
  test('uses the terminal dispatcher and marks the record as a terminal run', async () => {
    const harness = createTerminalHarness({
      frontmatter: { ai_task: true, ai_task_args: '--dangerously-skip-permissions' },
    })

    const record = await harness.manager.startRun(makeTaskFile(), {
      instanceId: 'inst-42',
    })

    expect(harness.terminal.runs).toHaveLength(1)
    expect(harness.headless.runs).toHaveLength(0)
    expect(record.mode).toBe('terminal')
    expect(record.instanceId).toBe('inst-42')
    expect(record.status).toBe('running')
    expect(record.pid).toBe(2222)
    expect(typeof record.transcriptPath).toBe('string')
    expect(record.transcriptPath).toContain('/tmp/fake-transcripts/')

    expect(harness.terminal.last.request).toEqual({
      binaryPath: '/bin/claude',
      prompt: 'Do the thing',
      cwd: '/vault/base',
      extraArgs: ['--dangerously-skip-permissions'],
      rows: 24,
      cols: 80,
      transcriptPath: record.transcriptPath,
    })
  })

  test('passes explicit terminal dimensions through to the dispatcher', async () => {
    const harness = createTerminalHarness()

    await harness.manager.startRun(makeTaskFile(), { rows: 40, cols: 132 })

    expect(harness.terminal.last.request.rows).toBe(40)
    expect(harness.terminal.last.request.cols).toBe(132)
  })

  test("options.mode 'headless' overrides the settings accessor", async () => {
    const harness = createTerminalHarness({ runMode: 'terminal' })

    const record = await harness.manager.startRun(makeTaskFile(), { mode: 'headless' })

    expect(record.mode).toBe('headless')
    expect(harness.headless.runs).toHaveLength(1)
    expect(harness.terminal.runs).toHaveLength(0)
    expect(record.transcriptPath).toBeUndefined()
  })

  test("the settings accessor decides the mode when options carry none", async () => {
    const harness = createTerminalHarness({ runMode: 'headless' })

    const record = await harness.manager.startRun(makeTaskFile())

    expect(harness.getRunMode).toHaveBeenCalled()
    expect(record.mode).toBe('headless')
    expect(harness.headless.runs).toHaveLength(1)
  })

  test('forces headless when the platform does not support a PTY (win32)', async () => {
    const harness = createTerminalHarness({ runMode: 'terminal', supported: false })

    const record = await harness.manager.startRun(makeTaskFile(), { mode: 'terminal' })

    expect(record.mode).toBe('headless')
    expect(harness.headless.runs).toHaveLength(1)
    expect(harness.terminal.runs).toHaveLength(0)
  })

  test('headless runs record mode headless and keep instanceId', async () => {
    const harness = createTerminalHarness({ runMode: 'headless' })

    const record = await harness.manager.startRun(makeTaskFile(), {
      instanceId: 'inst-7',
    })

    expect(record.mode).toBe('headless')
    expect(record.instanceId).toBe('inst-7')
  })
})

describe('AiTaskManager terminal data flow', () => {
  test('terminal output is NOT appended to record.events', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.emitData('raw chunk 1')
    harness.terminal.last.emitData('raw chunk 2')

    expect(record.events).toEqual([])
  })

  test('live subscribers receive chunks as they arrive', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const received: string[] = []

    harness.manager.onTerminalData(record.id, (chunk) => received.push(chunk))
    harness.terminal.last.emitData('one')
    harness.terminal.last.emitData('two')

    expect(received).toEqual(['one', 'two'])
  })

  test('late subscribers get the buffered data replayed, then live chunks', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.emitData('early-1 ')
    harness.terminal.last.emitData('early-2 ')

    const received: string[] = []
    harness.manager.onTerminalData(record.id, (chunk) => received.push(chunk))
    harness.terminal.last.emitData('live-3')

    expect(received.join('')).toBe('early-1 early-2 live-3')
  })

  test('the disposer stops delivery', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const received: string[] = []

    const dispose = harness.manager.onTerminalData(record.id, (chunk) =>
      received.push(chunk),
    )
    harness.terminal.last.emitData('kept')
    dispose()
    harness.terminal.last.emitData('dropped')

    expect(received).toEqual(['kept'])
  })

  test('subscribing to an unknown run returns a no-op disposer', () => {
    const harness = createTerminalHarness()

    const dispose = harness.manager.onTerminalData('missing-run', () => undefined)

    expect(() => dispose()).not.toThrow()
  })

  test('the replay ring buffer is bounded to TERMINAL_DATA_BUFFER_LIMIT', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    const chunkSize = 60_000
    for (const marker of ['A', 'B', 'C', 'D', 'E']) {
      harness.terminal.last.emitData(marker.repeat(chunkSize))
    }

    let replayed = ''
    harness.manager.onTerminalData(record.id, (chunk) => {
      replayed += chunk
    })

    expect(replayed.length).toBeLessThanOrEqual(TERMINAL_DATA_BUFFER_LIMIT)
    expect(replayed).not.toContain('A')
    expect(replayed.endsWith('E'.repeat(chunkSize))).toBe(true)
  })

  test('sendTerminalInput forwards data to the terminal handle', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.sendTerminalInput(record.id, 'ls -la\r')

    expect(harness.terminal.last.write).toHaveBeenCalledWith('ls -la\r')
  })

  test('sendTerminalInput is a no-op for finished, unknown, and headless runs', async () => {
    const harness = createTerminalHarness({ runMode: 'headless' })
    const record = await harness.manager.startRun(makeTaskFile())

    expect(() => harness.manager.sendTerminalInput(record.id, 'x')).not.toThrow()
    expect(() => harness.manager.sendTerminalInput('missing', 'x')).not.toThrow()

    const terminalHarness = createTerminalHarness()
    const terminalRecord = await terminalHarness.manager.startRun(makeTaskFile())
    terminalHarness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    terminalHarness.manager.sendTerminalInput(terminalRecord.id, 'late')
    expect(terminalHarness.terminal.last.write).not.toHaveBeenCalled()
  })
})

describe('AiTaskManager terminal exit and transcript log', () => {
  test('reads and deletes the transcript, then writes the log note with the ANSI-stripped content', async () => {
    const harness = createTerminalHarness({
      transcriptContent: '\u001b[31mhello\u001b[0m\r\nworld',
    })
    const record = await harness.manager.startRun(makeTaskFile())
    const transcriptPath = record.transcriptPath

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(record.status).toBe('succeeded')
    expect(record.exitCode).toBe(0)
    expect(harness.readAndDeleteFile).toHaveBeenCalledTimes(1)
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'hello\nworld')
    expect(record.logNotePath).toBe('terminal-log.md')
    expect(harness.pruneOldLogs).toHaveBeenCalledTimes(1)
    expect(harness.writeRunLog).not.toHaveBeenCalled()
  })

  test('a transcript read failure still writes the note with an empty transcript', async () => {
    const harness = createTerminalHarness()
    harness.readAndDeleteFile.mockRejectedValueOnce(new Error('read failed'))
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, '')
    expect(record.logNotePath).toBe('terminal-log.md')
  })

  test('falls back to writeRunLog when the writer lacks the terminal path', async () => {
    const harness = createTerminalHarness({ withTerminalWriter: false })
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeRunLog).toHaveBeenCalledWith(record)
  })

  test('a failing terminal exit maps to failed with the error message', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({
      status: 'failed',
      exitCode: 7,
      signal: null,
      errorMessage: 'Process exited with code 7',
    })
    await flushPromises()

    expect(record.status).toBe('failed')
    expect(record.errorMessage).toBe('Process exited with code 7')
  })

  test('stopRun and requestStopForTask drive the terminal handle stop', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.requestStopForTask(record.taskPath)

    expect(record.status).toBe('stopping')
    expect(harness.terminal.last.stop).toHaveBeenCalledTimes(1)

    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    expect(record.status).toBe('stopped')
  })

  test('an exit after dispose skips the log note but still cleans up the transcript file', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const transcriptPath = record.transcriptPath

    harness.manager.dispose()
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()

    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
  })
})

describe('AiTaskManager followUp on terminal runs', () => {
  test('rejects with a typed error because input goes through the terminal', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    await expect(
      harness.manager.followUp(record.id, 'more please'),
    ).rejects.toBeInstanceOf(AiTerminalFollowUpError)
    expect(harness.terminal.runs).toHaveLength(1)
    expect(harness.headless.runs).toHaveLength(0)
    expect(record.status).toBe('succeeded')
  })
})
