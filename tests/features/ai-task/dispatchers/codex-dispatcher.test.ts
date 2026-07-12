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
