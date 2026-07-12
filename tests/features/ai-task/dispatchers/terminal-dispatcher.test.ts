import * as path from 'path'
import { NodeProcessGateway } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import type {
  PtyCommand,
  PtyCommandRequest,
} from '../../../../src/features/ai-task/services/NodeProcessGateway'
import {
  TerminalDispatcher,
  buildTerminalEnv,
} from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type {
  TerminalRunHandle,
  TerminalRunRequest,
} from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { AiRunExitOutcome } from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import {
  FIXTURES_DIR,
  createRecordingGraceTimer,
  createSpyGateway,
  prepareFixture,
} from './dispatcherTestUtils'

const FAKE_INTERACTIVE = path.join(FIXTURES_DIR, 'fake-interactive.js')

const BASE_REQUEST: TerminalRunRequest = {
  binaryPath: '/bin/claude',
  prompt: 'do the thing',
  cwd: '/work/dir',
  extraArgs: ['--dangerously-skip-permissions'],
  rows: 30,
  cols: 100,
  transcriptPath: '/tmp/transcript.txt',
}

function noopCallbacks() {
  return { onData: jest.fn(), onExit: jest.fn() }
}

describe('TerminalDispatcher argv and spawn shape', () => {
  test('builds the PTY command from [...extraArgs, prompt] and spawns it with a piped stdin', () => {
    const gateway = createSpyGateway()
    const dispatcher = new TerminalDispatcher(gateway, createRecordingGraceTimer())

    dispatcher.start(BASE_REQUEST, noopCallbacks())

    expect(gateway.ptyMock).toHaveBeenCalledTimes(1)
    expect(gateway.ptyMock).toHaveBeenCalledWith({
      binaryPath: '/bin/claude',
      args: ['--dangerously-skip-permissions', 'do the thing'],
      rows: 30,
      cols: 100,
      transcriptPath: '/tmp/transcript.txt',
    })

    const ptyResult = gateway.ptyMock.mock.results[0].value as PtyCommand
    expect(gateway.spawnMock).toHaveBeenCalledTimes(1)
    const spawnRequest = gateway.spawnMock.mock.calls[0][0]
    expect(spawnRequest.command).toBe(ptyResult.command)
    expect(spawnRequest.args).toEqual(ptyResult.args)
    expect(spawnRequest.cwd).toBe('/work/dir')
    expect(spawnRequest.stdinMode).toBe('pipe')
  })

  test('an empty prompt starts a plain REPL (extraArgs only)', () => {
    const gateway = createSpyGateway()
    const dispatcher = new TerminalDispatcher(gateway, createRecordingGraceTimer())

    dispatcher.start({ ...BASE_REQUEST, prompt: '' }, noopCallbacks())

    const ptyRequest: PtyCommandRequest = gateway.ptyMock.mock.calls[0][0]
    expect(ptyRequest.args).toEqual(['--dangerously-skip-permissions'])
  })

  test('spawns with the terminal env (color-enabled, xterm TERM)', () => {
    const gateway = createSpyGateway()
    const dispatcher = new TerminalDispatcher(gateway, createRecordingGraceTimer())

    dispatcher.start(BASE_REQUEST, noopCallbacks())

    const env = gateway.spawnMock.mock.calls[0][0].env ?? {}
    expect('NO_COLOR' in env).toBe(false)
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    // Everything else from the base env is preserved.
    expect(env.BASE_ENV_MARKER).toBe('yes')
  })
})

describe('buildTerminalEnv', () => {
  const ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NO_COLOR'] as const
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('removes NO_COLOR and adds color/TERM variables on top of the base env', () => {
    const env = buildTerminalEnv({
      NO_COLOR: '1',
      HOME: '/Users/someone',
      PATH: '/usr/bin',
    })

    expect('NO_COLOR' in env).toBe(false)
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.HOME).toBe('/Users/someone')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('keeps the Claude Code markers deleted when layered on the real gateway base env', () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.NO_COLOR = '1'

    const env = buildTerminalEnv(new NodeProcessGateway().getBaseEnv())

    expect('CLAUDECODE' in env).toBe(false)
    expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false)
    expect('NO_COLOR' in env).toBe(false)
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.TERM).toBe('xterm-256color')
  })
})

describe('TerminalDispatcher exit-code sentinel', () => {
  interface ScriptedRun {
    emitStdout(text: string): void
    emitStderr(text: string): void
    exit(code: number | null, signal: string | null): void
    data: string[]
    outcomes: AiRunExitOutcome[]
    handle: TerminalRunHandle
  }

  function startScriptedRun(): ScriptedRun {
    let stdoutCb: (text: string) => void = () => undefined
    let stderrCb: (text: string) => void = () => undefined
    let exitCb: (code: number | null, signal: string | null) => void = () => undefined
    const gateway = createSpyGateway()
    gateway.spawnMock.mockImplementation(() => ({
      pid: 777,
      onStdout: (cb) => {
        stdoutCb = cb
      },
      onStderr: (cb) => {
        stderrCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      kill: jest.fn(),
      writeStdin: jest.fn(),
    }))
    const dispatcher = new TerminalDispatcher(gateway, createRecordingGraceTimer())
    const data: string[] = []
    const outcomes: AiRunExitOutcome[] = []
    const handle = dispatcher.start(BASE_REQUEST, {
      onData: (bytes) => data.push(bytes),
      onExit: (outcome) => outcomes.push(outcome),
    })
    return {
      emitStdout: (text) => stdoutCb(text),
      emitStderr: (text) => stderrCb(text),
      exit: (code, signal) => exitCb(code, signal),
      data,
      outcomes,
      handle,
    }
  }

  test('maps the sentinel code over the raw SIGKILL exit (clean session)', () => {
    const run = startScriptedRun()

    run.emitStderr('__TASKCHUTE_AI_EXIT__0\n')
    run.exit(null, 'SIGKILL')

    expect(run.outcomes).toEqual([
      { status: 'succeeded', exitCode: 0, signal: 'SIGKILL' },
    ])
    // The sentinel never reaches the terminal screen.
    expect(run.data.join('')).toBe('')
  })

  test('maps a non-zero sentinel code to failed', () => {
    const run = startScriptedRun()

    run.emitStderr('__TASKCHUTE_AI_EXIT__7\n')
    run.exit(null, 'SIGKILL')

    expect(run.outcomes[0].status).toBe('failed')
    expect(run.outcomes[0].exitCode).toBe(7)
    expect(run.outcomes[0].errorMessage).toContain('7')
  })

  test('relays surrounding stderr text while filtering the sentinel out', () => {
    const run = startScriptedRun()

    run.emitStderr('wrapper warning\n__TASKCHUTE_AI_EXIT__0\n')
    run.exit(null, 'SIGKILL')

    expect(run.data.join('')).toBe('wrapper warning\n')
    expect(run.outcomes[0].status).toBe('succeeded')
  })

  test('falls back to the raw exit when no sentinel arrived', () => {
    const run = startScriptedRun()

    run.exit(null, 'SIGKILL')

    expect(run.outcomes[0].status).toBe('failed')
    expect(run.outcomes[0].errorMessage).toContain('SIGKILL')
  })

  test('a requested stop still maps to stopped regardless of the sentinel', () => {
    const run = startScriptedRun()

    run.handle.stop()
    run.emitStderr('__TASKCHUTE_AI_EXIT__143\n')
    run.exit(null, 'SIGTERM')

    expect(run.outcomes[0].status).toBe('stopped')
  })
})

/**
 * A real gateway whose buildPtyCommand skips the `script` wrapper: the child
 * runs without a PTY, which is fine for exercising the relay/write/stop
 * plumbing against a real process.
 */
class PassthroughPtyGateway extends NodeProcessGateway {
  buildPtyCommand(request: PtyCommandRequest): PtyCommand {
    return { command: request.binaryPath, args: request.args }
  }
}

interface LiveRun {
  handle: TerminalRunHandle
  data: () => string
  waitForData(needle: string, timeoutMs?: number): Promise<void>
  waitForExit(): Promise<AiRunExitOutcome>
}

function startLiveRun(request: Partial<TerminalRunRequest> = {}): LiveRun {
  const gateway = new PassthroughPtyGateway()
  const dispatcher = new TerminalDispatcher(gateway)
  let data = ''
  let exitOutcome: AiRunExitOutcome | null = null
  const exitWaiters: Array<(outcome: AiRunExitOutcome) => void> = []

  const handle = dispatcher.start(
    {
      binaryPath: FAKE_INTERACTIVE,
      prompt: '',
      rows: 24,
      cols: 80,
      transcriptPath: '/tmp/unused-transcript.txt',
      ...request,
    },
    {
      onData: (bytes) => {
        data += bytes
      },
      onExit: (outcome) => {
        exitOutcome = outcome
        for (const waiter of exitWaiters.splice(0)) waiter(outcome)
      },
    },
  )

  return {
    handle,
    data: () => data,
    waitForData: (needle, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now()
        const poll = setInterval(() => {
          if (data.includes(needle)) {
            clearInterval(poll)
            resolve()
            return
          }
          if (Date.now() - startedAt > timeoutMs) {
            clearInterval(poll)
            reject(new Error(`Timed out waiting for terminal data "${needle}"; got: ${data}`))
          }
        }, 20)
      }),
    waitForExit: () => {
      if (exitOutcome) return Promise.resolve(exitOutcome)
      return new Promise<AiRunExitOutcome>((resolve) => {
        exitWaiters.push(resolve)
      })
    },
  }
}

describe('TerminalDispatcher live relay (real gateway, passthrough PTY)', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FAKE_INTERACTIVE)
  })

  afterAll(() => {
    restorePath()
  })

  test('relays raw output chunks and round-trips write() to the child stdin', async () => {
    const run = startLiveRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.write('ping\n')
    await run.waitForData('echo:ping')

    run.handle.write('exit\n')
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('succeeded')
    expect(outcome.exitCode).toBe(0)
    expect(run.data()).toContain('BYE')
  }, 20_000)

  test('maps a non-zero exit to failed', async () => {
    const run = startLiveRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.write('fail\n')
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('failed')
    expect(outcome.exitCode).toBe(7)
    expect(outcome.errorMessage).toContain('7')
  }, 20_000)

  test('stop() terminates the session and maps the exit to stopped', async () => {
    const run = startLiveRun()

    await run.waitForData('INTERACTIVE_READY')
    run.handle.stop()
    const outcome = await run.waitForExit()

    expect(outcome.status).toBe('stopped')
  }, 20_000)
})
