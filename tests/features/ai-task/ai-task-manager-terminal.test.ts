import { TFile } from 'obsidian'
import {
  AiPromptNotFoundError,
  AiTaskManager,
  AiTerminalFollowUpError,
  TERMINAL_DATA_BUFFER_LIMIT,
  TERMINAL_TRANSCRIPT_UNAVAILABLE_PLACEHOLDER,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiDispatcher,
  AiGraceTimer,
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
  /** Task note content; defaults to a note WITH a '## Prompt' section */
  content?: string
  /** Grace-timer override injected into the manager deps */
  timer?: AiGraceTimer
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
        cachedRead: jest.fn(
          async () => options.content ?? '# Task\n\n## Prompt\n\nDo the thing\n',
        ),
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
    timer: options.timer,
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

  test('records the PTY size on the record so the pane can open a matching terminal', async () => {
    const harness = createTerminalHarness()

    const record = await harness.manager.startRun(makeTaskFile(), {
      rows: 40,
      cols: 132,
    })

    expect(record.rows).toBe(40)
    expect(record.cols).toBe(132)
  })

  test('records the default PTY size when the caller provides none', async () => {
    const harness = createTerminalHarness()

    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.rows).toBe(24)
    expect(record.cols).toBe(80)
  })

  // Regression: the pane opens its ONE-SHOT xterm view synchronously on the
  // first 'starting' notification, reading the grid off the record. A grid
  // stamped only after that notification made the view open at the 80x24
  // fallback while the PTY spawned at the pane-derived size, garbling the
  // TUI for the run's entire lifetime.
  test("the first 'starting' notification already carries the pane-derived PTY grid", async () => {
    const harness = createTerminalHarness()
    const snapshots: Array<{
      status: string
      rows: number | undefined
      cols: number | undefined
      transcriptPath: string | undefined
    }> = []
    harness.manager.onChange((record) => {
      // Snapshot at notification time: the record object is mutable and
      // would otherwise look correct by the time the assertion runs.
      snapshots.push({
        status: record.status,
        rows: record.rows,
        cols: record.cols,
        transcriptPath: record.transcriptPath,
      })
    })

    await harness.manager.startRun(makeTaskFile(), { rows: 40, cols: 132 })

    expect(snapshots[0]).toEqual({
      status: 'starting',
      rows: 40,
      cols: 132,
      transcriptPath: expect.stringContaining('/tmp/fake-transcripts/'),
    })
  })

  test("the first 'starting' notification carries the default grid when the caller provides none", async () => {
    const harness = createTerminalHarness()
    let first: { rows: number | undefined; cols: number | undefined } | null = null
    harness.manager.onChange((record) => {
      if (first) return
      first = { rows: record.rows, cols: record.cols }
    })

    await harness.manager.startRun(makeTaskFile())

    expect(first).toEqual({ rows: 24, cols: 80 })
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

  test('a transcript read failure still writes the note, with a placeholder transcript', async () => {
    const harness = createTerminalHarness()
    harness.readAndDeleteFile.mockRejectedValueOnce(new Error('read failed'))
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      TERMINAL_TRANSCRIPT_UNAVAILABLE_PLACEHOLDER,
    )
    expect(TERMINAL_TRANSCRIPT_UNAVAILABLE_PLACEHOLDER.length).toBeGreaterThan(0)
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

describe('AiTaskManager terminal snapshot provider', () => {
  const RAW_TRANSCRIPT = '\u001b[31mgarbled spinner frame\u001b[0m'

  test('prefers the provider snapshot over the stripped transcript file and still deletes the temp file', async () => {
    const harness = createTerminalHarness({ transcriptContent: RAW_TRANSCRIPT })
    const provider = jest.fn(() => 'clean xterm buffer text')
    harness.manager.registerTerminalSnapshotProvider(provider)
    const record = await harness.manager.startRun(makeTaskFile())
    const transcriptPath = record.transcriptPath

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledWith(record.id)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      'clean xterm buffer text',
    )
    // Temp-file deletion behavior is kept even when the snapshot wins.
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
  })

  test('the snapshot is consumed AFTER the final status notification', async () => {
    const harness = createTerminalHarness()
    const statusesAtCapture: string[] = []
    harness.manager.registerTerminalSnapshotProvider((runId) => {
      statusesAtCapture.push(harness.manager.getRun(runId)?.status ?? 'missing')
      return 'buffer'
    })
    await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(statusesAtCapture).toEqual(['succeeded'])
  })

  test('falls back to the stripped transcript file when the provider returns undefined', async () => {
    const harness = createTerminalHarness({
      transcriptContent: '\u001b[31mhello\u001b[0m\r\nworld',
    })
    harness.manager.registerTerminalSnapshotProvider(() => undefined)
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'hello\nworld')
  })

  test('falls back to the stripped transcript file when the provider returns blank text', async () => {
    const harness = createTerminalHarness({
      transcriptContent: '\u001b[31mhello\u001b[0m\r\nworld',
    })
    harness.manager.registerTerminalSnapshotProvider(() => '   \n \n')
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'hello\nworld')
  })

  test('a throwing provider falls back to the stripped transcript file', async () => {
    const harness = createTerminalHarness({
      transcriptContent: '\u001b[31mhello\u001b[0m\r\nworld',
    })
    harness.manager.registerTerminalSnapshotProvider(() => {
      throw new Error('adapter gone')
    })
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'hello\nworld')
    expect(record.logNotePath).toBe('terminal-log.md')
  })

  test('the snapshot still wins when the transcript file read fails (no placeholder)', async () => {
    const harness = createTerminalHarness()
    harness.readAndDeleteFile.mockRejectedValueOnce(new Error('read failed'))
    harness.manager.registerTerminalSnapshotProvider(() => 'buffer text survives')
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      'buffer text survives',
    )
  })

  test('the disposer unregisters the provider so the file fallback applies again', async () => {
    const harness = createTerminalHarness({
      transcriptContent: '\u001b[31mhello\u001b[0m\r\nworld',
    })
    const provider = jest.fn(() => 'should not be used')
    const dispose = harness.manager.registerTerminalSnapshotProvider(provider)
    dispose()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(provider).not.toHaveBeenCalled()
    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'hello\nworld')
  })

  test('a later registration replaces the provider and a stale disposer never clobbers it', async () => {
    const harness = createTerminalHarness()
    const first = jest.fn(() => 'first provider')
    const second = jest.fn(() => 'second provider')
    const disposeFirst = harness.manager.registerTerminalSnapshotProvider(first)
    harness.manager.registerTerminalSnapshotProvider(second)
    // Stale disposer from the replaced provider must not remove the new one.
    disposeFirst()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(first).not.toHaveBeenCalled()
    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(record, 'second provider')
  })

  test('headless runs never consult the snapshot provider', async () => {
    const harness = createTerminalHarness({ runMode: 'headless' })
    const provider = jest.fn(() => 'terminal-only')
    harness.manager.registerTerminalSnapshotProvider(provider)
    await harness.manager.startRun(makeTaskFile())

    harness.headless.runs[0].exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(provider).not.toHaveBeenCalled()
    expect(harness.writeRunLog).toHaveBeenCalledTimes(1)
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

describe('AiTaskManager terminal prompt fallback', () => {
  const NO_PROMPT_CONTENT = '# Task\n\nJust notes, no prompt heading.\n'
  const EMPTY_PROMPT_CONTENT = '# Task\n\n## Prompt\n\n\n## Next\n\nBody\n'

  test('a terminal run without a "## Prompt" section starts a plain REPL (empty prompt)', async () => {
    const harness = createTerminalHarness({ content: NO_PROMPT_CONTENT })

    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.mode).toBe('terminal')
    expect(record.status).toBe('running')
    expect(harness.terminal.runs).toHaveLength(1)
    expect(harness.terminal.last.request.prompt).toBe('')
  })

  test('a terminal run with an empty "## Prompt" body also starts a plain REPL', async () => {
    const harness = createTerminalHarness({ content: EMPTY_PROMPT_CONTENT })

    const record = await harness.manager.startRun(makeTaskFile())

    expect(record.status).toBe('running')
    expect(harness.terminal.last.request.prompt).toBe('')
  })

  test('a headless run without a "## Prompt" section still rejects with the typed error', async () => {
    const harness = createTerminalHarness({
      runMode: 'headless',
      content: NO_PROMPT_CONTENT,
    })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiPromptNotFoundError,
    )
    expect(harness.headless.runs).toHaveLength(0)
    expect(harness.terminal.runs).toHaveLength(0)
    expect(harness.manager.getRuns()).toHaveLength(0)
  })

  test('a terminal request degraded to headless (no PTY) also rejects without a prompt', async () => {
    const harness = createTerminalHarness({
      supported: false,
      content: NO_PROMPT_CONTENT,
    })

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toBeInstanceOf(
      AiPromptNotFoundError,
    )
    expect(harness.terminal.runs).toHaveLength(0)
    expect(harness.headless.runs).toHaveLength(0)
  })
})

describe('AiTaskManager concurrent terminal runs', () => {
  test('stdin routing and terminal output stay independent per run', async () => {
    const harness = createTerminalHarness()
    const recordA = await harness.manager.startRun(
      makeTaskFile('TaskChute/Task/Task A.md', 'Task A'),
    )
    const recordB = await harness.manager.startRun(
      makeTaskFile('TaskChute/Task/Task B.md', 'Task B'),
    )
    const runA = harness.terminal.runs[0]
    const runB = harness.terminal.runs[1]

    harness.manager.sendTerminalInput(recordA.id, 'input-for-a')
    harness.manager.sendTerminalInput(recordB.id, 'input-for-b')

    expect(runA.write).toHaveBeenCalledTimes(1)
    expect(runA.write).toHaveBeenCalledWith('input-for-a')
    expect(runB.write).toHaveBeenCalledTimes(1)
    expect(runB.write).toHaveBeenCalledWith('input-for-b')

    const seenA: string[] = []
    const seenB: string[] = []
    harness.manager.onTerminalData(recordA.id, (chunk) => seenA.push(chunk))
    harness.manager.onTerminalData(recordB.id, (chunk) => seenB.push(chunk))
    runA.emitData('from-a')
    runB.emitData('from-b')

    expect(seenA).toEqual(['from-a'])
    expect(seenB).toEqual(['from-b'])

    // Independent teardown: stopping A leaves B running and typable.
    harness.manager.stopRun(recordA.id)
    runA.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()
    harness.manager.sendTerminalInput(recordB.id, 'still-alive')
    expect(runB.write).toHaveBeenLastCalledWith('still-alive')
    expect(recordA.status).toBe('stopped')
    expect(recordB.status).toBe('running')
  })

  test('each concurrent terminal run gets its own transcript temp file', async () => {
    const harness = createTerminalHarness()
    const recordA = await harness.manager.startRun(
      makeTaskFile('TaskChute/Task/Task A.md', 'Task A'),
    )
    const recordB = await harness.manager.startRun(
      makeTaskFile('TaskChute/Task/Task B.md', 'Task B'),
    )

    expect(recordA.transcriptPath).toBeDefined()
    expect(recordB.transcriptPath).toBeDefined()
    expect(recordA.transcriptPath).not.toBe(recordB.transcriptPath)
  })
})

describe('AiTaskManager dispose during live terminal sessions', () => {
  test('dispose() stops the session, escalates to forceKill, and silences terminal listeners', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    const record = await harness.manager.startRun(makeTaskFile())
    const run = harness.terminal.last
    const seen: string[] = []
    harness.manager.onTerminalData(record.id, (chunk) => seen.push(chunk))

    harness.manager.dispose()

    expect(run.stop).toHaveBeenCalledTimes(1)
    expect(run.forceKill).not.toHaveBeenCalled()

    // Listeners were cleared: output arriving mid-teardown reaches nobody.
    run.emitData('late chunk')
    expect(seen).toEqual([])

    // The grace timer fires -> SIGKILL escalation for the still-live handle.
    expect(timerCallbacks).toHaveLength(1)
    timerCallbacks[0]()
    expect(run.forceKill).toHaveBeenCalledTimes(1)
  })
})
