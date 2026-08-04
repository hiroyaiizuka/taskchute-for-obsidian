import { TFile } from 'obsidian'
import {
  AiPromptNotFoundError,
  AiTaskManager,
  AiTerminalFollowUpError,
  TERMINAL_DATA_BUFFER_LIMIT,
  TERMINAL_SNAPSHOT_PROVIDER_TIMEOUT_MS,
  TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT,
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
  resize: jest.Mock
  stop: jest.Mock
  forceKill: jest.Mock
  emitData(chunk: string): void
  exit(outcome: AiRunExitOutcome): void
}

class FakeTerminalDispatcher implements AiTerminalDispatcher {
  runs: FakeTerminalRun[] = []
  failNextStart: Error | null = null
  shutdown = jest.fn(async () => undefined)
  isPersistent = false

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
      resize: jest.fn(),
      stop: jest.fn(),
      forceKill: jest.fn(),
      emitData: (chunk) => callbacks.onData(chunk),
      exit: (outcome) => callbacks.onExit(outcome),
    }
    this.runs.push(run)
    return {
      pid: 2222,
      write: run.write,
      resize: run.resize,
      stop: run.stop,
      forceKill: run.forceKill,
    }
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
  /** Optional state bridge used by post-dispose callback race tests. */
  sessionStateSaveNow?: jest.Mock
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
  const listWorkspaceDirectory = jest.fn(async (rootPath: string) => ({
    rootPath,
    directoryPath: '',
    entries: [],
  }))
  const workspaceDocument = {
    rootPath: '/vault/base',
    relativePath: 'src/index.ts',
    absolutePath: '/vault/base/src/index.ts',
    content: 'const value = 1\n',
    version: { mtimeMs: 123, size: 16 },
  }
  const readWorkspaceFile = jest.fn(async () => workspaceDocument)
  const writeWorkspaceFile = jest.fn(async () => ({
    ...workspaceDocument,
    content: 'const value = 2\n',
    version: { mtimeMs: 456, size: 16 },
  }))

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
    workspaceFiles: {
      listDirectory: listWorkspaceDirectory,
      readFile: readWorkspaceFile,
      writeFile: writeWorkspaceFile,
    },
    getRunMode,
    timer: options.timer,
    ...(options.sessionStateSaveNow
      ? {
          sessionState: {
            load: jest.fn(() => []),
            scheduleSave: jest.fn(),
            saveNow: options.sessionStateSaveNow,
            flush: jest.fn(),
          },
        }
      : {}),
  }

  return {
    manager: new AiTaskManager(deps),
    deps,
    headless,
    terminal,
    writeRunLog,
    writeTerminalRunLog,
    pruneOldLogs,
    makeTempFilePath,
    readAndDeleteFile,
    isSupported,
    getRunMode,
    listWorkspaceDirectory,
    readWorkspaceFile,
    writeWorkspaceFile,
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
    expect(record.cwd).toBe('/vault/base')
    expect(typeof record.transcriptPath).toBe('string')
    expect(record.transcriptPath).toContain('/tmp/fake-transcripts/')

    expect(harness.terminal.last.request).toEqual({
      sessionId: record.id,
      binaryPath: '/bin/claude',
      binaryArgsPrefix: undefined,
      terminalFallbackCommand: 'claude',
      prompt: 'Do the thing',
      cwd: '/vault/base',
      extraArgs: ['--dangerously-skip-permissions'],
      launchInShell: true,
      rows: 24,
      cols: 80,
      transcriptPath: record.transcriptPath,
    })
  })

  test('renderer transition preserves a broker-owned terminal run', async () => {
    const harness = createTerminalHarness()
    harness.terminal.isPersistent = true
    await harness.manager.startRun(makeTaskFile(), { mode: 'terminal' })

    await harness.manager.stopNonPersistentRunsForRendererTransitionAndWait()

    expect(harness.terminal.last.stop).not.toHaveBeenCalled()
    expect(harness.terminal.last.forceKill).not.toHaveBeenCalled()
    expect(harness.manager.isDisposed()).toBe(false)
  })

  test('delegates lazy workspace listing through the desktop file service', async () => {
    const harness = createTerminalHarness()

    await expect(
      harness.manager.listWorkspaceDirectory('/vault/base', 'src'),
    ).resolves.toMatchObject({ rootPath: '/vault/base', entries: [] })
    expect(harness.listWorkspaceDirectory).toHaveBeenCalledWith(
      '/vault/base',
      'src',
    )
  })

  test('delegates workspace reads and version-checked writes through the file service', async () => {
    const harness = createTerminalHarness()

    const opened = await harness.manager.readWorkspaceFile(
      '/vault/base',
      'src/index.ts',
    )
    const saved = await harness.manager.writeWorkspaceFile(
      '/vault/base',
      'src/index.ts',
      'const value = 2\n',
      opened.version,
    )

    expect(opened.content).toBe('const value = 1\n')
    expect(saved.content).toBe('const value = 2\n')
    expect(harness.readWorkspaceFile).toHaveBeenCalledWith(
      '/vault/base',
      'src/index.ts',
    )
    expect(harness.writeWorkspaceFile).toHaveBeenCalledWith(
      '/vault/base',
      'src/index.ts',
      'const value = 2\n',
      { mtimeMs: 123, size: 16 },
    )
  })

  test('relays fitted xterm dimensions to the active PTY handle', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.resizeTerminal(record.id, 132, 41)

    expect(harness.terminal.last.resize).toHaveBeenCalledWith(132, 41)
    expect(record.cols).toBe(132)
    expect(record.rows).toBe(41)
  })

  test("a first-fit resize during the 'starting' notification becomes the spawned PTY grid", async () => {
    const harness = createTerminalHarness()
    harness.manager.onChange((record) => {
      if (record.status !== 'starting') return
      harness.manager.resizeTerminal(record.id, 96, 18)
    })

    const record = await harness.manager.startRun(makeTaskFile(), {
      rows: 30,
      cols: 120,
    })

    expect(harness.terminal.last.request.cols).toBe(96)
    expect(harness.terminal.last.request.rows).toBe(18)
    expect(record.cols).toBe(96)
    expect(record.rows).toBe(18)
    // The dispatcher was born at the corrected size; no redundant live
    // resize is needed before its handle exists.
    expect(harness.terminal.last.resize).not.toHaveBeenCalled()
  })

  test('resizeTerminal remains a no-op for a headless run without a PTY', async () => {
    const harness = createTerminalHarness({ runMode: 'headless' })
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.resizeTerminal(record.id, 96, 18)

    expect(record.cols).toBeUndefined()
    expect(record.rows).toBeUndefined()
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

  test('runtime dependency handoff preserves the live terminal handle', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const originalRun = harness.terminal.last
    const nextRuntime = createTerminalHarness()
    nextRuntime.manager.dispose()

    harness.manager.rebindRuntimeDependencies(nextRuntime.deps)
    harness.manager.sendTerminalInput(record.id, 'after-reload\r')

    expect(record.status).toBe('running')
    expect(originalRun.write).toHaveBeenCalledWith('after-reload\r')
    expect(originalRun.stop).not.toHaveBeenCalled()
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

  test('waits for an asynchronous xterm write barrier before composing the log', async () => {
    const harness = createTerminalHarness()
    let resolveSnapshot: ((value: string) => void) | null = null
    harness.manager.registerTerminalSnapshotProvider(
      () =>
        new Promise<string>((resolve) => {
          resolveSnapshot = resolve
        }),
    )
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
    })
    await flushPromises()
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()

    ;(resolveSnapshot as ((value: string) => void) | null)?.(
      'final parsed xterm output',
    )
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      'final parsed xterm output',
    )
  })

  test('times out a never-settling snapshot provider and completes transcript persistence', async () => {
    const timerCallbacks: Array<{
      handler: () => void
      timeoutMs: number
    }> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler, timeoutMs) => {
        timerCallbacks.push({ handler, timeoutMs })
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({
      timer,
      transcriptContent: '\u001b[32mfile fallback\u001b[0m',
    })
    harness.manager.registerTerminalSnapshotProvider(
      () => new Promise<string>(() => undefined),
    )
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
    })
    await Promise.resolve()

    expect(harness.manager.isRunExitPersisted(record.id)).toBe(false)
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
    expect(timerCallbacks).toHaveLength(1)
    expect(timerCallbacks[0].timeoutMs).toBe(
      TERMINAL_SNAPSHOT_PROVIDER_TIMEOUT_MS,
    )

    timerCallbacks[0].handler()
    await flushPromises()

    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      'file fallback',
    )
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(
      expect.stringContaining(record.id),
    )
    expect(harness.manager.isRunExitPersisted(record.id)).toBe(true)
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

  test('bounds ANSI projection work before writing a huge raw transcript fallback', async () => {
    const harness = createTerminalHarness({
      transcriptContent: `${'old\r'.repeat(
        Math.ceil(TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT / 4) + 1_000,
      )}\nFINAL`,
    })
    harness.manager.registerTerminalSnapshotProvider(() => undefined)
    await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
    })
    await flushPromises()

    const transcript = harness.writeTerminalRunLog.mock.calls[0]?.[1]
    expect(transcript).toContain(
      '[transcript projection truncated: showing the final terminal output]',
    )
    expect(transcript.endsWith('FINAL')).toBe(true)
    expect(transcript.length).toBeLessThanOrEqual(
      TERMINAL_TRANSCRIPT_STRIP_INPUT_LIMIT + 100,
    )
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

  test('unmounting a later background provider restores the visible provider', async () => {
    const harness = createTerminalHarness()
    const visibleProvider = jest.fn(() => 'visible buffer')
    const backgroundProvider = jest.fn(() => 'background buffer')
    harness.manager.registerTerminalSnapshotProvider(visibleProvider)
    const unmountBackground = harness.manager.registerTerminalSnapshotProvider(
      backgroundProvider,
    )

    // A short-lived Ambient TaskChute view registers after the visible view.
    // Detaching it must reveal the still-mounted visible provider again.
    unmountBackground()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(backgroundProvider).not.toHaveBeenCalled()
    expect(visibleProvider).toHaveBeenCalledWith(record.id)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
      record,
      'visible buffer',
    )
  })

  test.each([
    ['has no adapter for the run', () => undefined],
    ['returns a blank snapshot', () => '  \n '],
    ['throws while reading its adapter', () => {
      throw new Error('background adapter unavailable')
    }],
  ])(
    'falls back to the visible provider while the background provider %s',
    async (_scenario, backgroundSnapshot) => {
      const harness = createTerminalHarness()
      const visibleProvider = jest.fn(() => 'visible fallback buffer')
      const backgroundProvider = jest.fn(backgroundSnapshot)
      harness.manager.registerTerminalSnapshotProvider(visibleProvider)
      harness.manager.registerTerminalSnapshotProvider(backgroundProvider)
      const record = await harness.manager.startRun(makeTaskFile())

      harness.terminal.last.exit({
        status: 'succeeded',
        exitCode: 0,
        signal: null,
      })
      await flushPromises()

      expect(backgroundProvider).toHaveBeenCalledWith(record.id)
      expect(visibleProvider).toHaveBeenCalledWith(record.id)
      expect(harness.writeTerminalRunLog).toHaveBeenCalledWith(
        record,
        'visible fallback buffer',
      )
    },
  )

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

  test('disposeAndWait keeps app quit pending through the force-kill escalation', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    await harness.manager.startRun(makeTaskFile())
    const run = harness.terminal.last
    let completed = false

    const completion = harness.manager.disposeAndWait().then(() => {
      completed = true
    })
    await Promise.resolve()

    expect(run.stop).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    expect(timerCallbacks).toHaveLength(1)

    timerCallbacks[0]()
    await completion
    expect(run.forceKill).toHaveBeenCalledTimes(1)
    expect(completed).toBe(true)
  })

  test('a late unavailable callback after dispose cannot rewrite the final session snapshot', async () => {
    const saveNow = jest.fn()
    const harness = createTerminalHarness({ sessionStateSaveNow: saveNow })
    const record = await harness.manager.startRun(makeTaskFile())
    const lateTranscriptPath = record.transcriptPath as string

    harness.manager.dispose()
    const savesAtDispose = saveNow.mock.calls.length
    expect(record.status).toBe('running')

    harness.terminal.last.callbacks.onUnavailable?.(lateTranscriptPath)
    await flushPromises()

    expect(record.status).toBe('running')
    expect(record.endedAt).toBeUndefined()
    expect(record.errorMessage).toBeUndefined()
    expect(saveNow).toHaveBeenCalledTimes(savesAtDispose)
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(lateTranscriptPath)

    // Duplicate unavailable plus the ordinary exit race cannot consume the
    // same broker transcript twice.
    harness.terminal.last.callbacks.onUnavailable?.(lateTranscriptPath)
    harness.terminal.last.exit({
      status: 'stopped',
      exitCode: null,
      signal: 'SIGKILL',
    })
    await flushPromises()
    expect(harness.readAndDeleteFile).toHaveBeenCalledTimes(1)
  })

  test('an exit cleanup that wins the dispose race suppresses a duplicate late unavailable read', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const transcriptPath = record.transcriptPath as string

    harness.manager.dispose()
    harness.terminal.last.exit({
      status: 'stopped',
      exitCode: null,
      signal: 'SIGTERM',
    })
    harness.terminal.last.callbacks.onUnavailable?.(transcriptPath)
    await flushPromises()

    expect(harness.readAndDeleteFile).toHaveBeenCalledTimes(1)
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
  })

  test('disposeAndWait also awaits renderer-independent broker shutdown', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    await harness.manager.startRun(makeTaskFile())
    let finishShutdown: () => void = () => undefined
    harness.terminal.shutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve
        }),
    )
    let completed = false

    const completion = harness.manager.disposeAndWait().then(() => {
      completed = true
    })
    timerCallbacks[0]?.()
    await Promise.resolve()
    expect(completed).toBe(false)

    finishShutdown()
    await completion
    expect(harness.terminal.shutdown).toHaveBeenCalledTimes(1)
    expect(completed).toBe(true)
  })

  test('disposeAndWait reports broker shutdown failure only after force-kill cleanup finishes', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    await harness.manager.startRun(makeTaskFile())
    const shutdownError = new Error('broker shutdown unconfirmed')
    let rejectShutdown: (error: Error) => void = () => undefined
    harness.terminal.shutdown.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectShutdown = reject
        }),
    )
    let settled = false

    const completion = harness.manager.disposeAndWait().finally(() => {
      settled = true
    })
    // Observe the expected rejection immediately; dispose() also installs its
    // own passive observer for callers that do not use disposeAndWait().
    const assertion = expect(completion).rejects.toBe(shutdownError)
    rejectShutdown(shutdownError)
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(timerCallbacks).toHaveLength(1)
    timerCallbacks[0]?.()
    await assertion
    expect(harness.terminal.last.forceKill).toHaveBeenCalledTimes(1)
    expect(settled).toBe(true)

    // A later app-quit caller gets a fresh broker shutdown attempt instead
    // of the permanently cached rejected Promise.
    harness.terminal.shutdown.mockResolvedValue(undefined)
    await harness.manager.disposeAndWait()
    expect(harness.terminal.shutdown).toHaveBeenCalledTimes(2)
  })

  test('a shutdown retry still waits for the original force-kill cleanup', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    await harness.manager.startRun(makeTaskFile())
    harness.terminal.shutdown
      .mockRejectedValueOnce(new Error('first shutdown unconfirmed'))
      .mockResolvedValueOnce(undefined)

    // Settings OFF starts disposal without awaiting it. The broker failure
    // arrives before the delayed SIGKILL sweep.
    harness.manager.dispose()
    await flushPromises()

    let retrySettled = false
    const retry = harness.manager.disposeAndWait().then(() => {
      retrySettled = true
    })
    await flushPromises()

    expect(harness.terminal.shutdown).toHaveBeenCalledTimes(2)
    expect(retrySettled).toBe(false)
    expect(harness.terminal.last.forceKill).not.toHaveBeenCalled()

    timerCallbacks[0]?.()
    await retry
    expect(harness.terminal.last.forceKill).toHaveBeenCalledTimes(1)
    expect(retrySettled).toBe(true)
  })

  test('a failed shutdown retry also waits for the original force-kill cleanup', async () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createTerminalHarness({ timer })
    await harness.manager.startRun(makeTaskFile())
    harness.terminal.shutdown
      .mockRejectedValueOnce(new Error('first shutdown unconfirmed'))
      .mockRejectedValueOnce(new Error('retry shutdown unconfirmed'))

    harness.manager.dispose()
    await flushPromises()

    let retrySettled = false
    const retry = harness.manager.disposeAndWait().finally(() => {
      retrySettled = true
    })
    const assertion = expect(retry).rejects.toThrow('retry shutdown unconfirmed')
    await flushPromises()

    expect(harness.terminal.shutdown).toHaveBeenCalledTimes(2)
    expect(retrySettled).toBe(false)
    expect(harness.terminal.last.forceKill).not.toHaveBeenCalled()

    timerCallbacks[0]?.()
    await assertion
    expect(harness.terminal.last.forceKill).toHaveBeenCalledTimes(1)
    expect(retrySettled).toBe(true)
  })
})

describe('AiTaskManager carried fixes: stopped-run buffers + releaseRun', () => {
  test('drops the replay buffer of a stopped run after its persist chain', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.emitData('screen bytes')

    harness.manager.stopRun(record.id)
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()

    // Stopped runs never re-show in the pane, so their replay buffer is dead
    // memory: a late subscriber must get NO synchronous replay.
    const listener = jest.fn()
    harness.manager.onTerminalData(record.id, listener)
    expect(listener).not.toHaveBeenCalled()
  })

  test('keeps the replay buffer of a succeeded run for remount replay', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.emitData('screen bytes')

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    const listener = jest.fn()
    harness.manager.onTerminalData(record.id, listener)
    expect(listener).toHaveBeenCalledWith('screen bytes')
  })

  test('releaseRun drops a finished run from getRuns', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    harness.manager.releaseRun(record.id)

    expect(harness.manager.getRun(record.id)).toBeUndefined()
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('releaseRun never releases an active run', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.manager.releaseRun(record.id)

    expect(harness.manager.getRun(record.id)).toBe(record)
    // Unknown ids stay a safe no-op.
    expect(() => harness.manager.releaseRun('missing-run')).not.toThrow()
  })

  test('a dispatch-throw failed run can be released', async () => {
    const harness = createTerminalHarness()
    harness.terminal.failNextStart = new Error('spawn EACCES')

    await expect(harness.manager.startRun(makeTaskFile())).rejects.toThrow('spawn EACCES')
    await flushPromises()

    const failed = harness.manager.getRuns()[0]
    expect(failed?.status).toBe('failed')
    harness.manager.releaseRun(failed.id)
    expect(harness.manager.getRuns()).toEqual([])
  })

  test('broker give-up on a LIVE run marks it interrupted instead of leaving it running forever', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())
    const transcriptPath = record.transcriptPath
    harness.terminal.last.emitData('live output before the pipe died')
    expect(record.status).toBe('running')

    harness.terminal.last.callbacks.onUnavailable?.()

    const updated = harness.manager.getRun(record.id)
    expect(updated?.status).toBe('interrupted')
    expect(typeof updated?.errorMessage).toBe('string')
    expect(updated?.terminalSessionId).toBeUndefined()
    // The buffered output survives so the pane/replay still show the tail.
    let replayed = ''
    harness.manager.onTerminalData(record.id, (chunk) => {
      replayed += chunk
    })
    expect(replayed).toContain('live output before the pipe died')
    expect(
      harness.manager.claimInterruptedTaskStateReconciliation(record.id),
    ).toBe(true)

    // The broker calls onUnavailable only after the child is confirmed dead.
    // The manager must then run the same transcript/log cleanup chain as a
    // normal exit instead of dropping the trusted path on the floor.
    await flushPromises()
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
    expect(harness.manager.getRun(record.id)?.transcriptPath).toBeUndefined()

    // Late/duplicate terminal notifications lose the race and are no-ops:
    // one run has exactly one terminal persist chain.
    harness.terminal.last.callbacks.onUnavailable?.()
    harness.terminal.last.exit({
      status: 'stopped',
      exitCode: null,
      signal: 'SIGKILL',
    })
    await flushPromises()
    expect(harness.manager.getRun(record.id)?.status).toBe('interrupted')
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
  })

  test('a normal terminal exit that wins the unavailable race keeps its outcome', async () => {
    const harness = createTerminalHarness()
    const record = await harness.manager.startRun(makeTaskFile())

    harness.terminal.last.exit({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
    })
    harness.terminal.last.callbacks.onUnavailable?.()
    await flushPromises()

    expect(harness.manager.getRun(record.id)?.status).toBe('succeeded')
    expect(harness.writeTerminalRunLog).toHaveBeenCalledTimes(1)
  })
})
