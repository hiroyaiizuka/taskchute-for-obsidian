import * as fs from 'fs'
import * as path from 'path'
import { ClaudeCodeDispatcher } from '../../../../src/features/ai-task/services/dispatchers/ClaudeCodeDispatcher'
import { STOP_GRACE_MS } from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import { NodeProcessGateway } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import {
  FIXTURES_DIR,
  createRecordingGraceTimer,
  createSpyGateway,
  prepareFixture,
  runDispatcherToCompletion,
  startDispatcherRun,
} from './dispatcherTestUtils'

const FIXTURE = path.join(FIXTURES_DIR, 'fake-claude.js')

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !isProcessAlive(pid)
}

describe('ClaudeCodeDispatcher', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FIXTURE)
  })

  afterAll(() => {
    restorePath()
  })

  describe('argv construction (spawn spy)', () => {
    test('builds headless stream-json argv and appends extra args', () => {
      const gateway = createSpyGateway()
      const dispatcher = new ClaudeCodeDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/claude',
          prompt: 'say hi',
          cwd: '/some/project',
          extraArgs: ['--max-turns', '1'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      expect(gateway.spawnMock).toHaveBeenCalledTimes(1)
      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.command).toBe('/fake/bin/claude')
      expect(request.args).toEqual([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '1',
        '--',
        'say hi',
      ])
      expect(request.cwd).toBe('/some/project')
      expect(request.env).toBe(gateway.baseEnv)
    })

    test('omits cwd and extra args when not provided', () => {
      const gateway = createSpyGateway()
      const dispatcher = new ClaudeCodeDispatcher(gateway, createRecordingGraceTimer())

      const handle = dispatcher.start(
        { binaryPath: '/fake/bin/claude', prompt: 'p' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--', 'p'])
      expect(request.cwd).toBeUndefined()
      expect(handle.pid).toBe(4242)
    })

    test('keeps a prompt starting with a dash behind the end-of-options separator', () => {
      const gateway = createSpyGateway()
      const dispatcher = new ClaudeCodeDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        { binaryPath: '/fake/bin/claude', prompt: '- first bullet of the prompt' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      const separatorIndex = request.args.indexOf('--')
      expect(separatorIndex).toBeGreaterThanOrEqual(0)
      expect(request.args.slice(separatorIndex)).toEqual(['--', '- first bullet of the prompt'])
    })

    test('builds resume argv when resumeSessionId is set', () => {
      const gateway = createSpyGateway()
      const dispatcher = new ClaudeCodeDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/claude',
          prompt: 'continue please',
          cwd: '/some/project',
          extraArgs: ['--max-turns', '1'],
          resumeSessionId: 'sess-abc',
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        '-p',
        '--resume',
        'sess-abc',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '1',
        '--',
        'continue please',
      ])
      expect(request.cwd).toBe('/some/project')
    })

    test('ignores an empty resumeSessionId', () => {
      const gateway = createSpyGateway()
      const dispatcher = new ClaudeCodeDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        { binaryPath: '/fake/bin/claude', prompt: 'p', resumeSessionId: '' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--', 'p'])
    })
  })

  describe('fixture integration (real gateway)', () => {
    test('emits normalized events in order and maps exit 0 to succeeded', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
      })

      expect(events.map((event) => event.kind)).toEqual([
        'init',
        'assistant-text',
        'tool-use',
        'tool-result',
        'result',
      ])
      const [init, assistantText, toolUse, toolResult, result] = events
      expect(init).toMatchObject({ sessionId: 'fake-claude-session', model: 'fake-model' })
      expect(assistantText).toMatchObject({ text: 'Hello from fake claude' })
      expect(toolUse).toMatchObject({ toolName: 'Bash' })
      expect(toolResult).toMatchObject({ text: 'hi', isError: false })
      expect(result).toMatchObject({ subtype: 'success', isError: false })
      expect(outcome).toMatchObject({ status: 'succeeded', exitCode: 0 })
    }, 20_000)

    test('reassembles a multibyte character split mid-sequence across stdout chunks', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { events } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
        extraArgs: ['--multibyte'],
      })

      const assistantText = events.find((event) => event.kind === 'assistant-text')
      expect(assistantText).toMatchObject({ text: 'こんにちは、日本語の応答' })
      expect(JSON.stringify(events)).not.toContain('�')
    }, 20_000)

    test('spawns the child without CLAUDECODE markers and with NO_COLOR=1', async () => {
      process.env.CLAUDECODE = '1'
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
      try {
        const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
        const { events } = await runDispatcherToCompletion(dispatcher, {
          binaryPath: FIXTURE,
          prompt: 'say hi',
          extraArgs: ['--dump-env'],
        })

        const stderrEvent = events.find((event) => event.kind === 'stderr')
        expect(stderrEvent).toBeDefined()
        const childEnv = JSON.parse(
          stderrEvent && stderrEvent.kind === 'stderr' ? stderrEvent.text : '{}',
        ) as Record<string, string>
        expect(childEnv.CLAUDECODE).toBeUndefined()
        expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
        expect(childEnv.NO_COLOR).toBe('1')
      } finally {
        delete process.env.CLAUDECODE
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
    }, 20_000)

    test('spawns the child with the login-shell PATH merged in', async () => {
      const fakeLoginShell = path.join(FIXTURES_DIR, 'fake-login-shell.sh')
      fs.chmodSync(fakeLoginShell, 0o755)
      const savedShell = process.env.SHELL
      process.env.SHELL = fakeLoginShell
      try {
        const gateway = new NodeProcessGateway()
        await gateway.primeLoginShellPath()
        const dispatcher = new ClaudeCodeDispatcher(gateway)
        const { events } = await runDispatcherToCompletion(dispatcher, {
          binaryPath: FIXTURE,
          prompt: 'say hi',
          extraArgs: ['--dump-env'],
        })

        const stderrEvent = events.find((event) => event.kind === 'stderr')
        expect(stderrEvent).toBeDefined()
        const childEnv = JSON.parse(
          stderrEvent && stderrEvent.kind === 'stderr' ? stderrEvent.text : '{}',
        ) as Record<string, string>
        const childPathEntries = (childEnv.PATH ?? '').split(':')
        // Login-shell entries lead the child PATH...
        expect(childPathEntries[0]).toBe('/fake-login-dir/bin')
        expect(childPathEntries).toContain('/fake-login-dir/sbin')
        // ...and the original process entries are still reachable.
        expect(childPathEntries).toContain(path.dirname(process.execPath))
      } finally {
        if (savedShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = savedShell
        }
      }
    }, 20_000)

    test('maps a non-zero exit code to failed', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
        extraArgs: ['--exit-code', '3'],
      })

      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBe(3)
    }, 20_000)

    test('maps an is_error result to failed even when the exit code is 0', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
        extraArgs: ['--error-result'],
      })

      const result = events.find((event) => event.kind === 'result')
      expect(result).toMatchObject({ isError: true })
      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBe(0)
    }, 20_000)

    test('stop() terminates a hanging child via SIGTERM and clears the grace timer', async () => {
      const graceTimer = createRecordingGraceTimer()
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway(), graceTimer)
      const run = startDispatcherRun(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
        extraArgs: ['--hang'],
      })

      await run.waitForEvent('init')
      run.handle.stop()
      const outcome = await run.waitForExit()

      expect(outcome.status).toBe('stopped')
      expect(outcome.exitCode).toBeNull()
      expect(outcome.signal).toBe('SIGTERM')
      expect(graceTimer.scheduled).toEqual([{ handle: 1, timeoutMs: STOP_GRACE_MS }])
      expect(graceTimer.cleared).toEqual([1])
    }, 20_000)

    test('stop() kills grandchild tool subprocesses via the process group', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway(), createRecordingGraceTimer())
      const run = startDispatcherRun(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'say hi',
        extraArgs: ['--hang', '--spawn-child'],
      })

      const stderrEvent = await run.waitForEvent('stderr')
      const stderrText = stderrEvent.kind === 'stderr' ? stderrEvent.text : ''
      const pidMatch = /GRANDCHILD_PID:(\d+)/.exec(stderrText) ?? []
      const grandchildPid = Number(pidMatch[1])
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(isProcessAlive(grandchildPid)).toBe(true)
      await run.waitForEvent('init')

      run.handle.stop()
      const outcome = await run.waitForExit()

      expect(outcome.status).toBe('stopped')
      // The grandchild shares the child's process group, so the stop signal
      // must reach it too — otherwise it would survive as an orphan.
      expect(await waitForProcessExit(grandchildPid, 10_000)).toBe(true)
    }, 20_000)

    test('resume flow emits the continuation stream', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'continue please',
        resumeSessionId: 'fake-claude-session',
      })

      const init = events.find((event) => event.kind === 'init')
      expect(init).toMatchObject({ sessionId: 'fake-claude-session-2' })
      const assistantText = events.find((event) => event.kind === 'assistant-text')
      expect(assistantText).toMatchObject({ text: 'Follow-up from fake claude' })
      expect(outcome).toMatchObject({ status: 'succeeded', exitCode: 0 })
    }, 20_000)

    test('stop() after exit is a no-op', async () => {
      const graceTimer = createRecordingGraceTimer()
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway(), graceTimer)
      const run = startDispatcherRun(dispatcher, { binaryPath: FIXTURE, prompt: 'say hi' })

      const outcome = await run.waitForExit()
      run.handle.stop()

      expect(outcome.status).toBe('succeeded')
      expect(graceTimer.scheduled).toEqual([])
    }, 20_000)

    test('reports a spawn failure as failed with a stderr event', async () => {
      const dispatcher = new ClaudeCodeDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: '/nonexistent/fake-claude-binary',
        prompt: 'say hi',
      })

      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBeNull()
      const stderrEvent = events.find((event) => event.kind === 'stderr')
      expect(stderrEvent && stderrEvent.kind === 'stderr' ? stderrEvent.text : '').toContain('ENOENT')
    }, 20_000)
  })
})
