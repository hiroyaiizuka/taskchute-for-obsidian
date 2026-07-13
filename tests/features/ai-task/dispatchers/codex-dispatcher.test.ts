import * as path from 'path'
import { CodexDispatcher } from '../../../../src/features/ai-task/services/dispatchers/CodexDispatcher'
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

const FIXTURE = path.join(FIXTURES_DIR, 'fake-codex.js')

describe('CodexDispatcher', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FIXTURE)
  })

  afterAll(() => {
    restorePath()
  })

  describe('argv construction (spawn spy)', () => {
    test('builds exec --json argv with cwd, extra args, and trailing prompt', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'do the thing',
          cwd: '/some/project',
          extraArgs: ['--model', 'gpt-5'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      expect(gateway.spawnMock).toHaveBeenCalledTimes(1)
      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.command).toBe('/fake/bin/codex')
      expect(request.args).toEqual([
        'exec',
        '--json',
        '--cd',
        '/some/project',
        '--skip-git-repo-check',
        '--model',
        'gpt-5',
        '--',
        'do the thing',
      ])
      expect(request.cwd).toBe('/some/project')
      expect(request.env).toBe(gateway.baseEnv)
    })

    test('omits --cd when cwd is not provided', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        { binaryPath: '/fake/bin/codex', prompt: 'p' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--', 'p'])
    })

    test('passes model and reasoning config through as literal argv tokens', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'deep task',
          extraArgs: [
            '--model=gpt-5.6-terra',
            '--config',
            'model_reasoning_effort="xhigh"',
          ],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      expect(gateway.spawnMock.mock.calls[0][0].args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--model=gpt-5.6-terra',
        '--config',
        'model_reasoning_effort="xhigh"',
        '--',
        'deep task',
      ])
    })

    test('keeps a prompt starting with a dash behind the end-of-options separator', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        { binaryPath: '/fake/bin/codex', prompt: '--not-a-flag prompt body' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      const separatorIndex = request.args.indexOf('--')
      expect(separatorIndex).toBeGreaterThanOrEqual(0)
      expect(request.args.slice(separatorIndex)).toEqual(['--', '--not-a-flag prompt body'])
    })

    test('builds exec resume argv when resumeSessionId is set (no --cd: unsupported by resume)', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'continue please',
          cwd: '/some/project',
          extraArgs: ['--model', 'gpt-5'],
          resumeSessionId: '019f54b3-17be-72f0-901f-a3a6c67c795b',
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      // `codex exec resume --help` (0.144.1): resume takes [SESSION_ID] [PROMPT]
      // positionals plus --json/--skip-git-repo-check, but has NO --cd flag.
      // The working directory still applies through the spawn cwd below.
      expect(request.args).toEqual([
        'exec',
        'resume',
        '019f54b3-17be-72f0-901f-a3a6c67c795b',
        '--json',
        '--skip-git-repo-check',
        '--model',
        'gpt-5',
        '--',
        'continue please',
      ])
      expect(request.args).not.toContain('--cd')
      expect(request.cwd).toBe('/some/project')
    })

    test('ignores an empty resumeSessionId', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        { binaryPath: '/fake/bin/codex', prompt: 'p', resumeSessionId: '' },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--', 'p'])
    })

    test('strips interactive-only approval flags (modal "Full auto") but keeps --sandbox', () => {
      // The U3 modal writes the interactive full-auto pair into ai_task_args;
      // `codex exec` (0.144.1) has no --ask-for-approval flag and exits 2 on
      // it, so the headless pipeline must drop it while keeping --sandbox.
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'p',
          extraArgs: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--',
        'p',
      ])
    })

    test('strips the = and short (-a) approval flag forms from hand-authored args', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'p',
          extraArgs: ['--ask-for-approval=never', '-a', 'on-request', '-a=never', '--model', 'gpt-5'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--model',
        'gpt-5',
        '--',
        'p',
      ])
    })

    test("strips clap's attached short approval form (-anever) too", () => {
      // Carried fix: clap accepts the value glued onto the short flag
      // ('-anever' == '-a never'); hand-authored ai_task_args can carry it.
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'p',
          extraArgs: ['-anever', '--sandbox', 'workspace-write'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--',
        'p',
      ])
    })

    test('a bare -a consumes only a value token, never a following flag', () => {
      // Carried fix: '-a --sandbox ...' must not swallow --sandbox as the
      // policy value, and a trailing bare -a has nothing to consume.
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'p',
          extraArgs: ['-a', '--sandbox', 'workspace-write', '--ask-for-approval'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--',
        'p',
      ])
    })

    test('strips approval flags on the exec resume path too', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/codex',
          prompt: 'continue',
          extraArgs: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
          resumeSessionId: 'session-1',
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.args).toEqual([
        'exec',
        'resume',
        'session-1',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--',
        'continue',
      ])
    })

    test('drops the codex stdin notice from stderr but keeps real stderr lines', () => {
      // codex 0.144.1 prints this line for ANY non-tty stdin — even the
      // /dev/null the gateway hands it — so the dispatcher filters it.
      const gateway = createSpyGateway()
      let stderrListener: ((text: string) => void) | undefined
      gateway.spawnMock.mockImplementation(() => ({
        pid: 4242,
        onStdout: () => undefined,
        onStderr: (listener: (text: string) => void) => {
          stderrListener = listener
        },
        onExit: () => undefined,
        kill: () => undefined,
      }))
      const dispatcher = new CodexDispatcher(gateway, createRecordingGraceTimer())
      const events: Array<{ kind: string; text?: string }> = []

      dispatcher.start(
        { binaryPath: '/fake/bin/codex', prompt: 'p' },
        { onEvent: (event) => events.push(event), onExit: () => undefined },
      )
      stderrListener?.('Reading additional input from stdin...\n')
      stderrListener?.('real warning\n')

      expect(events).toEqual([{ kind: 'stderr', text: 'real warning' }])
    })
  })

  describe('fixture integration (real gateway)', () => {
    test('emits normalized events in order and maps turn.completed to succeeded', async () => {
      const dispatcher = new CodexDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'do the thing',
      })

      expect(events.map((event) => event.kind)).toEqual(['init', 'assistant-text', 'result'])
      const [init, assistantText, result] = events
      expect(init).toMatchObject({ sessionId: 'fake-codex-thread', model: 'fake-codex-model' })
      expect(assistantText).toMatchObject({ text: 'Hello from fake codex' })
      expect(result).toMatchObject({ subtype: 'turn.completed', isError: false })
      expect(outcome).toMatchObject({ status: 'succeeded', exitCode: 0 })
    }, 20_000)

    test('spawns the child without CLAUDECODE markers and with NO_COLOR=1', async () => {
      process.env.CLAUDECODE = '1'
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
      try {
        const dispatcher = new CodexDispatcher(new NodeProcessGateway())
        const { events } = await runDispatcherToCompletion(dispatcher, {
          binaryPath: FIXTURE,
          prompt: 'do the thing',
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

    test('headless run created with the modal full-auto args still succeeds', async () => {
      // End-to-end regression for the carried BLOCKING issue: a codex task
      // note created via the U3 modal in Full auto must run headlessly.
      const dispatcher = new CodexDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'do the thing',
        extraArgs: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
      })

      expect(events.map((event) => event.kind)).toEqual(['init', 'assistant-text', 'result'])
      expect(outcome).toMatchObject({ status: 'succeeded', exitCode: 0 })
    }, 20_000)

    test('maps a non-zero exit code to failed', async () => {
      const dispatcher = new CodexDispatcher(new NodeProcessGateway())
      const { outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'do the thing',
        extraArgs: ['--exit-code', '2'],
      })

      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBe(2)
    }, 20_000)

    test('maps turn.failed to failed even when the exit code is 0', async () => {
      const dispatcher = new CodexDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'do the thing',
        extraArgs: ['--error-result'],
      })

      const result = events.find((event) => event.kind === 'result')
      expect(result).toMatchObject({
        subtype: 'turn.failed',
        isError: true,
        text: 'fake codex failure',
      })
      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBe(0)
    }, 20_000)

    test('resume flow emits the continuation stream on the same thread', async () => {
      const dispatcher = new CodexDispatcher(new NodeProcessGateway())
      const { events, outcome } = await runDispatcherToCompletion(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'continue please',
        resumeSessionId: 'fake-codex-thread',
      })

      const init = events.find((event) => event.kind === 'init')
      expect(init).toMatchObject({ sessionId: 'fake-codex-thread' })
      const assistantText = events.find((event) => event.kind === 'assistant-text')
      expect(assistantText).toMatchObject({ text: 'Follow-up from fake codex' })
      expect(outcome).toMatchObject({ status: 'succeeded', exitCode: 0 })
    }, 20_000)

    test('stop() terminates a hanging child via SIGTERM and clears the grace timer', async () => {
      const graceTimer = createRecordingGraceTimer()
      const dispatcher = new CodexDispatcher(new NodeProcessGateway(), graceTimer)
      const run = startDispatcherRun(dispatcher, {
        binaryPath: FIXTURE,
        prompt: 'do the thing',
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
  })
})
