import * as path from 'path'
import { CursorDispatcher } from '@/features/ai-task/services/dispatchers/CursorDispatcher'
import { NodeProcessGateway } from '@/features/ai-task/services/NodeProcessGateway'
import {
  FIXTURES_DIR,
  createRecordingGraceTimer,
  createSpyGateway,
  prepareFixture,
  runDispatcherToCompletion,
} from './dispatcherTestUtils'

const FIXTURE = path.join(FIXTURES_DIR, 'fake-cursor.js')

describe('CursorDispatcher', () => {
  let restorePath: () => void

  beforeAll(() => {
    restorePath = prepareFixture(FIXTURE)
  })

  afterAll(() => {
    restorePath()
  })

  describe('argv construction (spawn spy)', () => {
    test('runs headless stream-json, trusts the workspace, and keeps the prompt behind --', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CursorDispatcher(gateway, createRecordingGraceTimer())

      dispatcher.start(
        {
          binaryPath: '/fake/bin/cursor-agent',
          prompt: '--looks-like-a-flag',
          cwd: '/some/project',
          extraArgs: ['--model', 'auto', '--force'],
        },
        { onEvent: () => undefined, onExit: () => undefined },
      )

      const request = gateway.spawnMock.mock.calls[0][0]
      expect(request.command).toBe('/fake/bin/cursor-agent')
      expect(request.args).toEqual([
        '-p',
        '--output-format',
        'stream-json',
        '--trust',
        '--model',
        'auto',
        '--force',
        '--',
        '--looks-like-a-flag',
      ])
      // The workspace is the spawn cwd.
      expect(request.cwd).toBe('/some/project')
    })

    test('a follow-up resumes the session; an empty session id is ignored', () => {
      const gateway = createSpyGateway()
      const dispatcher = new CursorDispatcher(gateway, createRecordingGraceTimer())
      const callbacks = { onEvent: () => undefined, onExit: () => undefined }

      dispatcher.start({ binaryPath: 'c', prompt: 'more', resumeSessionId: 'abc-123' }, callbacks)
      dispatcher.start({ binaryPath: 'c', prompt: 'p', resumeSessionId: '' }, callbacks)

      expect(gateway.spawnMock.mock.calls[0][0].args).toEqual([
        '-p', '--output-format', 'stream-json', '--trust', '--resume', 'abc-123', '--', 'more',
      ])
      expect(gateway.spawnMock.mock.calls[1][0].args).toEqual([
        '-p', '--output-format', 'stream-json', '--trust', '--', 'p',
      ])
    })
  })

  describe('real child process (fake-cursor.js)', () => {
    test('streams init, the reply, the tool call, and a successful result', async () => {
      const { events, outcome } = await runDispatcherToCompletion(
        new CursorDispatcher(new NodeProcessGateway()),
        { binaryPath: FIXTURE, prompt: 'say hello' },
      )

      expect(outcome.status).toBe('succeeded')
      expect(events).toEqual([
        { kind: 'init', sessionId: 'fake-cursor-session', model: 'Auto' },
        { kind: 'assistant-text', text: 'Hello from fake cursor' },
        { kind: 'tool-use', toolName: 'shell', input: { command: 'echo hi' } },
        { kind: 'tool-result', text: 'hi\n', isError: false },
        { kind: 'result', subtype: 'success', isError: false, text: 'done' },
      ])
    })

    test('a follow-up continues the same session', async () => {
      const { events, outcome } = await runDispatcherToCompletion(
        new CursorDispatcher(new NodeProcessGateway()),
        { binaryPath: FIXTURE, prompt: 'and then?', resumeSessionId: 'earlier-session' },
      )

      expect(outcome.status).toBe('succeeded')
      expect(events[0]).toEqual({ kind: 'init', sessionId: 'earlier-session', model: 'Auto' })
      expect(events).toContainEqual({ kind: 'assistant-text', text: 'Follow-up from fake cursor' })
    })

    test('not logged in: the run fails and the CLI message is kept', async () => {
      const { events, outcome } = await runDispatcherToCompletion(
        new CursorDispatcher(new NodeProcessGateway()),
        { binaryPath: FIXTURE, prompt: 'p', extraArgs: ['--not-logged-in'] },
      )

      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBe(1)
      expect(events).toContainEqual({
        kind: 'raw',
        text: expect.stringContaining('Authentication required'),
      })
    })
  })
})
