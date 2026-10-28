/**
 * AiTaskManager plain shell sessions (U2):
 *   - startShellSession({cols, rows, name}) synchronously spawns the user's
 *     login shell ($SHELL -i -l, verified interactive under the script PTY
 *     wrapper) through the terminal dispatcher, cwd = vault base path
 *   - the record is a TERMINAL-mode run with host 'shell', a display name
 *     (i18n label provided by the caller), and NO task note (taskPath '')
 *   - shell sessions are never task runs: getActiveRunForTask /
 *     requestStopForTask ignore them, and several can run concurrently
 *   - exits skip the log note AND the retention prune, but still consume the
 *     PTY transcript temp file and still end with the 'persisted'
 *     notification (the pane's close flow waits for it)
 *   - dispose() extends the zombie guard to shell sessions (SIGTERM sweep +
 *     SIGKILL escalation)
 */
import {
  AiShellUnavailableError,
  AiTaskManager,
  AiTaskManagerDisposedError,
  AiTerminalFollowUpError,
  SHELL_SESSION_ARGS,
  type AiRunChangeType,
  type AiTaskManagerDeps,
} from '@/features/ai-task/services/AiTaskManager'
import type {
  AiDispatcher,
  AiGraceTimer,
  AiRunExitOutcome,
} from '@/features/ai-task/services/dispatchers/Dispatcher'
import type {
  AiTerminalDispatcher,
  TerminalRunCallbacks,
  TerminalRunRequest,
} from '@/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { AiRunRecord } from '@/features/ai-task/types'
import type { ShellForegroundProbe } from '@/features/ai-task/services/terminal-title/ShellForegroundProbe'
import type { ShellForegroundSample } from '@/features/ai-task/services/terminal-title/foregroundSnapshot'

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
    return { pid: 3333, write: run.write, stop: run.stop, forceKill: run.forceKill }
  }

  get last(): FakeTerminalRun {
    if (this.runs.length === 0) throw new Error('No terminal run started')
    return this.runs[this.runs.length - 1]
  }
}

interface HarnessOptions {
  supported?: boolean
  withGetShellPath?: boolean
  withTerminal?: boolean
  timer?: AiGraceTimer
  probeShellForeground?: ShellForegroundProbe
  shellArgs?: readonly string[]
}

function createShellHarness(options: HarnessOptions = {}) {
  const headless: AiDispatcher = {
    start: () => {
      throw new Error('headless dispatch not expected')
    },
  }
  const terminal = new FakeTerminalDispatcher()
  const writeRunLog = jest.fn(async () => 'headless-log.md')
  const writeTerminalRunLog = jest.fn<Promise<string>, [AiRunRecord, string]>(
    async () => 'terminal-log.md',
  )
  const pruneOldLogs = jest.fn(async () => undefined)
  const makeTempFilePath = jest.fn(
    (prefix: string) => `/tmp/fake-transcripts/${prefix}.log`,
  )
  const readAndDeleteFile = jest.fn(async () => 'transcript body')
  const getShellPath = jest.fn(() => '/bin/zsh')
  const withTerminal = options.withTerminal ?? true

  const deps: AiTaskManagerDeps = {
    app: {
      vault: {
        cachedRead: jest.fn(async () => '# Task\n\n## Prompt\n\nGo\n'),
        adapter: { getBasePath: () => '/vault/base' },
      },
      metadataCache: {
        getFileCache: jest.fn(() => ({ frontmatter: { ai_task: true } })),
      },
    },
    dispatchers: { claude: headless, codex: headless, cursor: headless },
    binaryLocator: { resolve: jest.fn(async () => '/bin/claude') },
    logWriter: { writeRunLog, writeTerminalRunLog, pruneOldLogs },
    terminal: withTerminal
      ? {
          dispatcher: terminal,
          isSupported: () => options.supported ?? true,
          makeTempFilePath,
          readAndDeleteFile,
          ...(options.withGetShellPath ?? true ? { getShellPath } : {}),
          ...(options.shellArgs ? { getShellArgs: () => options.shellArgs! } : {}),
          ...(options.probeShellForeground
            ? { probeShellForeground: options.probeShellForeground }
            : {}),
        }
      : undefined,
    getRunMode: () => 'terminal',
    timer: options.timer,
  }

  return {
    manager: new AiTaskManager(deps),
    terminal,
    writeRunLog,
    writeTerminalRunLog,
    pruneOldLogs,
    makeTempFilePath,
    readAndDeleteFile,
    getShellPath,
  }
}

describe('AiTaskManager.startShellSession spawn shape', () => {
  test("passes the terminal's own shell arguments when it has them (Windows PowerShell)", () => {
    const harness = createShellHarness({ shellArgs: ['-NoLogo'] })

    harness.manager.startShellSession()

    expect(harness.terminal.last.request.extraArgs).toEqual(['-NoLogo'])
  })

  test('synchronously spawns the login shell through the terminal dispatcher', () => {
    const harness = createShellHarness()

    const record = harness.manager.startShellSession({
      cols: 100,
      rows: 28,
      name: 'ターミナル',
    })

    expect(harness.terminal.runs).toHaveLength(1)
    expect(harness.terminal.last.request).toEqual({
      sessionId: record.id,
      binaryPath: '/bin/zsh',
      prompt: '',
      cwd: '/vault/base',
      extraArgs: [...SHELL_SESSION_ARGS],
      rows: 28,
      cols: 100,
      transcriptPath: record.transcriptPath,
      mayReplaceBroker: expect.any(Function) as unknown,
    })
    expect(harness.getShellPath).toHaveBeenCalled()
    expect(record.host).toBe('shell')
    expect(record.mode).toBe('terminal')
    expect(record.status).toBe('running')
    expect(record.pid).toBe(3333)
    expect(record.taskName).toBe('ターミナル')
    // Shell sessions have no task note behind them.
    expect(record.taskPath).toBe('')
    expect(record.rows).toBe(28)
    expect(record.cols).toBe(100)
    expect(typeof record.transcriptPath).toBe('string')
  })

  test('the shell args request an interactive login shell', () => {
    // Verified on-device: $SHELL -i -l stays interactive under the
    // script(1) PTY wrapper, echoes typed commands, records the transcript,
    // and dies cleanly on a process-group SIGTERM.
    expect(SHELL_SESSION_ARGS).toEqual(['-i', '-l'])
  })

  test('inherits an owning AI run workspace and records the owner id', () => {
    const harness = createShellHarness()

    const record = harness.manager.startShellSession({
      cwd: '/workspace/project',
      parentRunId: 'ai-run-parent',
    })

    expect(record.cwd).toBe('/workspace/project')
    expect(record.parentRunId).toBe('ai-run-parent')
    expect(harness.terminal.last.request.cwd).toBe('/workspace/project')
  })

  test('applies the default grid and display name when options are omitted', () => {
    const harness = createShellHarness()

    const record = harness.manager.startShellSession()

    expect(record.rows).toBe(24)
    expect(record.cols).toBe(80)
    expect(record.taskName).toBe('Terminal')
    expect(harness.terminal.last.request.rows).toBe(24)
    expect(harness.terminal.last.request.cols).toBe(80)
  })

  test("the first 'starting' notification already carries the grid and transcript path", () => {
    const harness = createShellHarness()
    const snapshots: Array<{
      status: string
      host: string
      rows: number | undefined
      cols: number | undefined
      transcriptPath: string | undefined
    }> = []
    harness.manager.onChange((record) => {
      snapshots.push({
        status: record.status,
        host: record.host,
        rows: record.rows,
        cols: record.cols,
        transcriptPath: record.transcriptPath,
      })
    })

    harness.manager.startShellSession({ cols: 90, rows: 20 })

    expect(snapshots[0]).toEqual({
      status: 'starting',
      host: 'shell',
      rows: 20,
      cols: 90,
      transcriptPath: expect.stringContaining('/tmp/fake-transcripts/'),
    })
  })

  test('throws the typed error when the platform has no PTY support', () => {
    const harness = createShellHarness({ supported: false })

    expect(() => harness.manager.startShellSession()).toThrow(
      AiShellUnavailableError,
    )
    expect(harness.terminal.runs).toHaveLength(0)
    expect(harness.manager.getRuns()).toHaveLength(0)
  })

  test('throws the typed error when terminal capabilities are absent', () => {
    const harness = createShellHarness({ withTerminal: false })

    expect(() => harness.manager.startShellSession()).toThrow(
      AiShellUnavailableError,
    )
  })

  test('throws the typed error when the deps lack getShellPath', () => {
    const harness = createShellHarness({ withGetShellPath: false })

    expect(() => harness.manager.startShellSession()).toThrow(
      AiShellUnavailableError,
    )
    expect(harness.terminal.runs).toHaveLength(0)
  })

  test('throws after dispose', () => {
    const harness = createShellHarness()
    harness.manager.dispose()

    expect(() => harness.manager.startShellSession()).toThrow(
      AiTaskManagerDisposedError,
    )
  })

  test('a dispatch failure marks the record failed and still ends with persisted', async () => {
    const harness = createShellHarness()
    harness.terminal.failNextStart = new Error('spawn refused')
    const notifications: Array<{ status: string; changeType: AiRunChangeType }> = []
    harness.manager.onChange((record, changeType) => {
      notifications.push({ status: record.status, changeType })
    })

    expect(() => harness.manager.startShellSession()).toThrow('spawn refused')
    await flushPromises()

    const record = harness.manager.getRuns()[0]
    expect(record.status).toBe('failed')
    expect(record.errorMessage).toBe('spawn refused')
    expect(notifications).toContainEqual({ status: 'failed', changeType: 'persisted' })
    // Even the failure path never writes a note for shell sessions.
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
    expect(harness.writeRunLog).not.toHaveBeenCalled()
    expect(harness.pruneOldLogs).not.toHaveBeenCalled()
    // ...but the transcript temp file is still consumed.
    expect(harness.readAndDeleteFile).toHaveBeenCalledTimes(1)
  })
})

describe('AiTaskManager shell sessions are never task runs', () => {
  test('getActiveRunForTask never returns a shell session', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()

    expect(record.status).toBe('running')
    expect(harness.manager.getActiveRunForTask('')).toBeUndefined()
    expect(harness.manager.getActiveRunForTask(record.taskPath)).toBeUndefined()
  })

  test('requestStopForTask leaves shell sessions alone', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()

    harness.manager.requestStopForTask('')
    harness.manager.requestStopForTask(record.taskPath)

    expect(harness.terminal.last.stop).not.toHaveBeenCalled()
    expect(record.status).toBe('running')
  })

  test('multiple shell sessions run concurrently without an already-active rejection', () => {
    const harness = createShellHarness()

    const first = harness.manager.startShellSession()
    const second = harness.manager.startShellSession()

    expect(first.id).not.toBe(second.id)
    expect(first.status).toBe('running')
    expect(second.status).toBe('running')
    expect(harness.terminal.runs).toHaveLength(2)
    expect(first.transcriptPath).not.toBe(second.transcriptPath)
  })

  test('stdin routing and output stay per-session across concurrent shells', () => {
    const harness = createShellHarness()
    const first = harness.manager.startShellSession()
    const second = harness.manager.startShellSession()
    const runA = harness.terminal.runs[0]
    const runB = harness.terminal.runs[1]

    harness.manager.sendTerminalInput(first.id, 'ls\r')
    harness.manager.sendTerminalInput(second.id, 'pwd\r')

    expect(runA.write).toHaveBeenCalledTimes(1)
    expect(runA.write).toHaveBeenCalledWith('ls\r')
    expect(runB.write).toHaveBeenCalledTimes(1)
    expect(runB.write).toHaveBeenCalledWith('pwd\r')

    const seenA: string[] = []
    const seenB: string[] = []
    harness.manager.onTerminalData(first.id, (chunk) => seenA.push(chunk))
    harness.manager.onTerminalData(second.id, (chunk) => seenB.push(chunk))
    runA.emitData('a-output')
    runB.emitData('b-output')

    expect(seenA).toEqual(['a-output'])
    expect(seenB).toEqual(['b-output'])
  })

  test('followUp on a finished shell session rejects with the terminal error', async () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    await expect(
      harness.manager.followUp(record.id, 'more'),
    ).rejects.toBeInstanceOf(AiTerminalFollowUpError)
  })
})

describe('AiTaskManager shell session exit', () => {
  test('skips the log note and the retention prune but still consumes the transcript', async () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    const transcriptPath = record.transcriptPath

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(record.status).toBe('succeeded')
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
    expect(harness.writeRunLog).not.toHaveBeenCalled()
    expect(harness.pruneOldLogs).not.toHaveBeenCalled()
    expect(record.logNotePath).toBeUndefined()
    expect(harness.readAndDeleteFile).toHaveBeenCalledTimes(1)
    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
    expect(record.transcriptPath).toBeUndefined()
  })

  test("still fires the 'persisted' notification so the pane can close the view", async () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    const changeTypes: AiRunChangeType[] = []
    harness.manager.onChange((changed, changeType) => {
      if (changed.id === record.id) changeTypes.push(changeType)
    })

    harness.manager.stopRun(record.id)
    expect(harness.terminal.last.stop).toHaveBeenCalledTimes(1)
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()

    expect(record.status).toBe('stopped')
    expect(changeTypes[changeTypes.length - 1]).toBe('persisted')
  })

  test('never consults the terminal snapshot provider', async () => {
    const harness = createShellHarness()
    const provider = jest.fn(() => 'xterm buffer')
    harness.manager.registerTerminalSnapshotProvider(provider)
    harness.manager.startShellSession()

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    await flushPromises()

    expect(provider).not.toHaveBeenCalled()
  })
})

describe('AiTaskManager dispose covers shell sessions (zombie guard)', () => {
  test('dispose() stops live shell sessions and escalates to forceKill', () => {
    const timerCallbacks: Array<() => void> = []
    const timer: AiGraceTimer = {
      setTimeout: (handler) => {
        timerCallbacks.push(handler)
        return timerCallbacks.length
      },
      clearTimeout: jest.fn(),
    }
    const harness = createShellHarness({ timer })
    harness.manager.startShellSession()
    harness.manager.startShellSession()
    const runA = harness.terminal.runs[0]
    const runB = harness.terminal.runs[1]

    harness.manager.dispose()

    expect(runA.stop).toHaveBeenCalledTimes(1)
    expect(runB.stop).toHaveBeenCalledTimes(1)
    expect(runA.forceKill).not.toHaveBeenCalled()

    expect(timerCallbacks).toHaveLength(1)
    timerCallbacks[0]()
    expect(runA.forceKill).toHaveBeenCalledTimes(1)
    expect(runB.forceKill).toHaveBeenCalledTimes(1)
  })

  test('an exit after dispose still cleans up the transcript temp file', async () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    const transcriptPath = record.transcriptPath

    harness.manager.dispose()
    harness.terminal.last.exit({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })
    await flushPromises()

    expect(harness.readAndDeleteFile).toHaveBeenCalledWith(transcriptPath)
    expect(harness.writeTerminalRunLog).not.toHaveBeenCalled()
  })
})

describe('AiTaskManager shell session tab names (LEV-376)', () => {
  const title = (text: string) => `\u001b]0;${text}\u0007`
  const CLAUDE = { pid: 100, name: 'Claude Code' }

  /** Fires timers by hand; the foreground monitor is the only user here. */
  class ManualTimer implements AiGraceTimer {
    private nextId = 1
    readonly pending = new Map<number, () => void>()
    setTimeout = (handler: () => void): number => {
      const id = this.nextId++
      this.pending.set(id, handler)
      return id
    }
    clearTimeout = (id: number): void => {
      this.pending.delete(id)
    }
    async fire(): Promise<void> {
      const handlers = Array.from(this.pending.values())
      this.pending.clear()
      for (const handler of handlers) handler()
      await flushPromises()
    }
  }

  let clock = 1_000_000
  beforeEach(() => {
    clock = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  function setup() {
    const timer = new ManualTimer()
    let answer: ShellForegroundSample | null = { program: null }
    const probe = jest.fn<ReturnType<ShellForegroundProbe>, Parameters<ShellForegroundProbe>>(
      async (paths) => new Map(paths.map((path) => [path, answer])),
    )
    const harness = createShellHarness({ timer, probeShellForeground: probe })
    const changes: AiRunRecord[] = []
    harness.manager.onChange((record) => changes.push({ ...record }))
    return {
      ...harness,
      timer,
      probe,
      changes,
      answer: (next: ShellForegroundSample | null) => {
        answer = next
      },
    }
  }

  test('a program in the foreground names the tab: its title, then "Terminal" again once it exits', async () => {
    const h = setup()
    const record = h.manager.startShellSession({ name: 'ターミナル' })

    // At the prompt: nothing to name.
    clock += 300
    await h.timer.fire()
    expect(h.probe).toHaveBeenCalledWith([record.transcriptPath])
    expect(record.terminalLabel).toBeUndefined()

    // `claude` starts and names itself; the early poll sees it in the foreground.
    clock += 1000
    h.answer({ program: CLAUDE })
    h.terminal.last.emitData(`${title('✳ Claude Code')}welcome`)
    expect(record.terminalTitle).toBe('Claude Code')
    clock += 300
    await h.timer.fire()
    expect(record.terminalLabel).toBe('Claude Code')

    // Its conversation title replaces it straight away, and is announced.
    clock += 100
    const before = h.changes.length
    h.terminal.last.emitData(title('⠂ ID63 書き直し'))
    expect(record.terminalLabel).toBe('ID63 書き直し')
    expect(h.changes.length).toBe(before + 1)
    expect(h.changes[h.changes.length - 1].terminalLabel).toBe('ID63 書き直し')

    // /exit: back at the prompt.
    clock += 2000
    h.answer({ program: null })
    await h.timer.fire()
    expect(record.terminalLabel).toBeUndefined()
    expect(record.terminalTitle).toBeUndefined()
  })

  test("spinner frames of the same title don't bring the next poll forward", async () => {
    const h = setup()
    h.manager.startShellSession({ name: 'ターミナル' })
    h.answer({ program: CLAUDE })
    await h.timer.fire()
    h.terminal.last.emitData(title('⠂ ID63 書き直し'))
    await h.timer.fire()
    const polls = h.probe.mock.calls.length
    const scheduled = Array.from(h.timer.pending.keys())
    for (const frame of ['⠐', '⠂', '⠐', '✳']) {
      h.terminal.last.emitData(title(`${frame} ID63 書き直し`))
    }
    // The regular poll is still the one scheduled; nothing was brought forward.
    expect(Array.from(h.timer.pending.keys())).toEqual(scheduled)
    expect(h.probe).toHaveBeenCalledTimes(polls)
  })

  test('a program without a title is named after itself', async () => {
    const h = setup()
    const record = h.manager.startShellSession({ name: 'ターミナル' })
    h.answer({ program: { pid: 7, name: 'Codex' } })
    await h.timer.fire()
    expect(record.terminalLabel).toBe('Codex')
  })

  test('an ended session goes back to its own name, and polling stops', async () => {
    const h = setup()
    const record = h.manager.startShellSession({ name: 'ターミナル' })
    h.answer({ program: CLAUDE })
    await h.timer.fire()
    h.terminal.last.emitData(title('ID63 書き直し'))
    expect(record.terminalLabel).toBe('ID63 書き直し')
    expect(h.timer.pending.size).toBe(1)

    h.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })
    expect(record.terminalLabel).toBeUndefined()
    expect(record.terminalTitle).toBeUndefined()
    // The pane hears about the exit with the name already gone.
    const last = h.changes[h.changes.length - 1]
    expect(last.status).toBe('succeeded')
    expect(last.terminalLabel).toBeUndefined()
    expect(h.timer.pending.size).toBe(0)
    const calls = h.probe.mock.calls.length
    await h.timer.fire()
    expect(h.probe).toHaveBeenCalledTimes(calls)
  })

  test('dispose stops polling', async () => {
    const h = setup()
    h.manager.startShellSession({ name: 'ターミナル' })
    h.manager.dispose()
    // Only the dispose-time force-kill escalation may remain scheduled.
    await h.timer.fire()
    expect(h.probe).not.toHaveBeenCalled()
  })

  test('without foreground detection the latest title is kept as the name', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession({ name: 'ターミナル' })
    harness.terminal.last.emitData(title('vim notes.md'))
    expect(record.terminalLabel).toBe('vim notes.md')
  })
})

/**
 * When the terminal machinery itself fails, the terminal used to show nothing:
 * a red tab over an empty screen, and keystrokes that went nowhere. The
 * manager now puts a localized notice on the run record for the pane to show.
 * It never goes into the PTY stream: a full-screen TUI would be corrupted by
 * it, and it would replay with the terminal after a reload.
 */
describe('AiTaskManager terminal machinery notices', () => {
  function replayOf(
    harness: ReturnType<typeof createShellHarness>,
    runId: string,
  ): string {
    const chunks: string[] = []
    const unsubscribe = harness.manager.onTerminalData(runId, (chunk) => chunks.push(chunk))
    unsubscribe()
    return chunks.join('')
  }

  test('a missing Node.js fails the shell with a notice, not terminal output', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()

    harness.terminal.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'Node.js was not found.',
      terminalFailure: 'node-not-found',
    })

    const run = harness.manager.getRun(record.id)
    expect(run?.status).toBe('failed')
    expect(run?.terminalNotice).toMatchObject({ kind: 'start-failed' })
    expect(run?.terminalNotice?.message).toContain('Node.js was not found. The terminal needs Node.js to run.')
    expect(replayOf(harness, record.id)).toBe('')
  })

  test('any other start failure carries the broker reason', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()

    harness.terminal.last.exit({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: 'Terminal process owner watchdog is unavailable',
      terminalFailure: 'broker-refused',
    })

    expect(harness.manager.getRun(record.id)?.terminalNotice?.message).toBe(
      'The terminal could not start: Terminal process owner watchdog is unavailable',
    )
  })

  test('an ordinary non-zero exit carries no notice', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    harness.terminal.last.emitData('bye\r\n')

    harness.terminal.last.exit({
      status: 'failed',
      exitCode: 1,
      signal: null,
      errorMessage: 'Process exited with code 1',
    })

    expect(harness.manager.getRun(record.id)?.terminalNotice).toBeUndefined()
    expect(replayOf(harness, record.id)).toBe('bye\r\n')
  })

  test('a lost connection and dropped input update the notice and notify listeners', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    const callbacks = harness.terminal.last.callbacks
    const notices: string[] = []
    harness.manager.onChange((changed) => {
      if (changed.id === record.id && changed.terminalNotice) {
        notices.push(changed.terminalNotice.kind)
      }
    })

    callbacks.onConnectionLost?.()
    callbacks.onInputDropped?.()

    expect(notices).toEqual(['connection-lost', 'input-dropped'])
    // Still running: termination is being confirmed, not yet given up.
    expect(harness.manager.getRun(record.id)?.status).toBe('running')
    expect(replayOf(harness, record.id)).toBe('')
  })

  test('a run that then ends normally drops its connection notice', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    harness.terminal.last.callbacks.onConnectionLost?.()
    expect(harness.manager.getRun(record.id)?.terminalNotice?.kind).toBe('connection-lost')

    harness.terminal.last.exit({ status: 'succeeded', exitCode: 0, signal: null })

    expect(harness.manager.getRun(record.id)?.terminalNotice).toBeUndefined()
  })

  test('notices raised in the same millisecond still get distinct, increasing sequence numbers', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()
    const seqs: number[] = []
    harness.manager.onChange((changed) => {
      if (changed.id === record.id && changed.terminalNotice) seqs.push(changed.terminalNotice.seq)
    })
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      harness.terminal.last.callbacks.onConnectionLost?.()
      harness.terminal.last.callbacks.onInputDropped?.()
    } finally {
      now.mockRestore()
    }

    expect(seqs).toHaveLength(2)
    expect(seqs[1]).toBeGreaterThan(seqs[0] ?? Infinity)
  })

  test('giving up on the session marks it interrupted with a notice', () => {
    const harness = createShellHarness()
    const record = harness.manager.startShellSession()

    harness.terminal.last.callbacks.onUnavailable?.()

    const run = harness.manager.getRun(record.id)
    expect(run?.status).toBe('interrupted')
    expect(run?.terminalNotice).toMatchObject({
      kind: 'interrupted',
      message: 'This terminal can no longer be reached, so it was stopped.',
    })
    expect(replayOf(harness, record.id)).toBe('')
  })
})

describe('AiTaskManager.restartTerminals (LEV-405)', () => {
  const stopped = (): AiRunExitOutcome => ({ status: 'stopped', exitCode: null, signal: 'SIGTERM' })

  function manualTimer() {
    const pending = new Map<number, { callback: () => void; ms: number }>()
    let nextId = 1
    const timer: AiGraceTimer = {
      setTimeout: (callback, ms) => {
        const id = nextId++
        pending.set(id, { callback, ms })
        return id
      },
      clearTimeout: (id) => {
        pending.delete(id)
      },
    }
    /** Fire every timer due within ms, in order. */
    const run = (ms: number) => {
      for (const [id, entry] of [...pending].sort((a, b) => a[1].ms - b[1].ms)) {
        if (entry.ms > ms || !pending.has(id)) continue
        pending.delete(id)
        entry.callback()
      }
    }
    return { timer, run }
  }

  function withBroker(options: HarnessOptions = {}) {
    const harness = createShellHarness(options)
    const replaceBroker = jest.fn(() => Promise.resolve())
    Object.assign(harness.terminal, { replaceBroker })
    return { ...harness, replaceBroker }
  }

  test('is offered only where terminals run in a broker that can be replaced', () => {
    expect(createShellHarness().manager.canRestartTerminals()).toBe(false)
    expect(withBroker().manager.canRestartTerminals()).toBe(true)
  })

  test('stops every terminal, waits for them to end, then replaces the broker', async () => {
    const { manager, terminal, replaceBroker } = withBroker()
    manager.startShellSession()
    manager.startShellSession()
    expect(manager.countLiveTerminals()).toBe(2)

    const restart = manager.restartTerminals()
    await flushPromises()
    expect(terminal.runs.map((run) => run.stop.mock.calls.length)).toEqual([1, 1])
    expect(replaceBroker).not.toHaveBeenCalled()

    terminal.runs[0].exit(stopped())
    await flushPromises()
    expect(replaceBroker).not.toHaveBeenCalled()
    terminal.runs[1].exit(stopped())
    await restart

    expect(replaceBroker).toHaveBeenCalledTimes(1)
    expect(manager.countLiveTerminals()).toBe(0)
  })

  test('force-kills a terminal that does not end, and gives up waiting after a while', async () => {
    const { timer, run } = manualTimer()
    const { manager, terminal, replaceBroker } = withBroker({ timer })
    manager.startShellSession()

    const restart = manager.restartTerminals()
    run(1500)
    expect(terminal.last.forceKill).toHaveBeenCalledTimes(1)
    expect(replaceBroker).not.toHaveBeenCalled()

    run(10_000)
    await restart
    // The broker client refuses while a session is left; that error reaches the user.
    expect(replaceBroker).toHaveBeenCalledTimes(1)
  })

  test('lets a refused terminal start on a new broker only when it is the only one running', () => {
    const { manager, terminal } = withBroker()
    manager.startShellSession()
    const first = terminal.last.request
    expect(first.mayReplaceBroker?.()).toBe(true)

    manager.startShellSession()
    expect(first.mayReplaceBroker?.()).toBe(false)
    expect(terminal.last.request.mayReplaceBroker?.()).toBe(false)

    terminal.runs[0].exit(stopped())
    expect(terminal.last.request.mayReplaceBroker?.()).toBe(true)
  })

  test('a shell is a terminal but not an AI task', () => {
    const { manager } = withBroker()
    manager.startShellSession()
    expect(manager.countLiveTerminals()).toBe(1)
    expect(manager.countLiveTerminalTasks()).toBe(0)
  })

  test('replaces the broker at once when no terminal is running', async () => {
    const { manager, replaceBroker } = withBroker()
    await manager.restartTerminals()
    expect(replaceBroker).toHaveBeenCalledTimes(1)
  })
})
