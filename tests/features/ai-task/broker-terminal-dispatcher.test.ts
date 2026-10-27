import type { ProcessGateway } from '@/features/ai-task/services/NodeProcessGateway'
import { BrokerTerminalDispatcher } from '@/features/ai-task/services/dispatchers/BrokerTerminalDispatcher'
import type { TerminalSessionBrokerClient } from '@/features/ai-task/services/TerminalSessionBroker'
import { POSIX_TERMINAL_BOOTSTRAP } from '@/features/ai-task/services/dispatchers/TerminalShellBootstrap'
import type { AiRunExitOutcome } from '@/features/ai-task/services/dispatchers/Dispatcher'

function makeGateway(): ProcessGateway {
  return {
    getShellPath: jest.fn(() => '/bin/zsh'),
    buildPtyCommand: jest.fn(() => ({
      command: '/bin/sh',
      args: ['-c', 'pty-wrapper'],
    })),
    getBaseEnv: jest.fn(() => ({
      PATH: '/usr/bin:/bin',
      NO_COLOR: '1',
    })),
  } as unknown as ProcessGateway
}

function makeBroker(): jest.Mocked<
  Pick<
    TerminalSessionBrokerClient,
    | 'start'
    | 'attach'
    | 'write'
    | 'resize'
    | 'stop'
    | 'detach'
    | 'scheduleShutdownAfterGrace'
    | 'cancelDeferredShutdown'
    | 'setRendererLeaseToken'
    | 'shutdown'
    | 'hasSessions'
    | 'replaceBroker'
  >
> {
  return {
    start: jest.fn(),
    attach: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    stop: jest.fn(),
    detach: jest.fn(),
    scheduleShutdownAfterGrace: jest.fn(),
    cancelDeferredShutdown: jest.fn(),
    setRendererLeaseToken: jest.fn(),
    shutdown: jest.fn(),
    hasSessions: jest.fn(() => false),
    replaceBroker: jest.fn(() => Promise.resolve()),
  }
}

/** The callbacks the dispatcher passed to broker.start on that call. */
function startCallbacks(
  broker: ReturnType<typeof makeBroker>,
  call = 0,
): { onData(bytes: string): void; onExit(outcome: AiRunExitOutcome): void } {
  return broker.start.mock.calls[call][4]
}

/** Callbacks reach the run unchanged, through the dispatcher's own onExit. */
const relayedCallbacks = expect.objectContaining({
  onData: expect.any(Function),
  onExit: expect.any(Function),
}) as unknown

describe('BrokerTerminalDispatcher', () => {
  test('starts the existing PTY wrapper in the broker and returns IPC controls', () => {
    const gateway = makeGateway()
    const broker = makeBroker()
    const dispatcher = new BrokerTerminalDispatcher(
      gateway,
      broker as unknown as TerminalSessionBrokerClient,
    )
    const callbacks = {
      onData: jest.fn(),
      onExit: jest.fn(),
    }

    const handle = dispatcher.start(
      {
        sessionId: 'ai-run-42',
        binaryPath: '/opt/homebrew/bin/claude',
        prompt: 'say hello',
        cwd: '/vault',
        extraArgs: ['--model', 'fable'],
        rows: 30,
        cols: 120,
        transcriptPath: '/tmp/run-42.log',
        launchInShell: true,
      },
      callbacks,
    )

    expect(gateway.buildPtyCommand).toHaveBeenCalledWith({
      binaryPath: '/bin/zsh',
      args: [
        '-i',
        '-l',
        '-c',
        POSIX_TERMINAL_BOOTSTRAP,
        'taskchute-ai',
        '/bin/zsh',
        '/opt/homebrew/bin/claude',
        '',
        '',
        '0',
        '--model',
        'fable',
        '--',
        'say hello',
      ],
      rows: 30,
      cols: 120,
      transcriptPath: '/tmp/run-42.log',
    })
    expect(broker.start).toHaveBeenCalledWith(
      'ai-run-42',
      {
        command: '/bin/sh',
        args: ['-c', 'pty-wrapper'],
        cwd: '/vault',
        env: {
          PATH: '/usr/bin:/bin',
          FORCE_COLOR: '1',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
        stdinMode: 'pipe',
      },
      '/tmp/run-42.log',
      undefined,
      relayedCallbacks,
    )
    startCallbacks(broker).onData('hello')
    expect(callbacks.onData).toHaveBeenCalledWith('hello')

    handle.write('next\r')
    handle.resize?.(90, 24)
    handle.stop()
    handle.forceKill?.()

    expect(handle.sessionId).toBe('ai-run-42')
    expect(broker.write).toHaveBeenCalledWith('ai-run-42', 'next\r')
    expect(broker.resize).toHaveBeenCalledWith(
      'ai-run-42',
      90,
      24,
    )
    expect(broker.stop).toHaveBeenNthCalledWith(1, 'ai-run-42', false)
    expect(broker.stop).toHaveBeenNthCalledWith(2, 'ai-run-42', true)
  })

  test('on Windows runs the ConPTY host in the broker, CLI first and PowerShell after', () => {
    const gateway = {
      getShellPath: jest.fn(() => {
        throw new Error('Windows has no login shell to wrap the CLI in')
      }),
      getPtyTransport: jest.fn(() => 'conpty'),
      buildPtyCommand: jest.fn(() => ({
        command: 'C:\\Windows\\powershell.exe',
        args: ['-NoLogo', '-Command', 'host-loader'],
        env: { TASKCHUTE_CONPTY_COMMAND_LINE: 'claude.exe -- hi' },
      })),
      getBaseEnv: jest.fn(() => ({ Path: 'C:\\Windows', NO_COLOR: '1' })),
    } as unknown as ProcessGateway
    const broker = makeBroker()
    const dispatcher = new BrokerTerminalDispatcher(
      gateway,
      broker as unknown as TerminalSessionBrokerClient,
    )
    const callbacks = { onData: jest.fn(), onExit: jest.fn() }

    const handle = dispatcher.start(
      {
        sessionId: 'ai-run-7',
        binaryPath: 'C:\\bin\\claude.exe',
        binaryArgsPrefix: ['entry.js'],
        prompt: 'hi',
        cwd: 'C:\\vault',
        rows: 30,
        cols: 120,
        transcriptPath: 'C:\\Temp\\run-7.log',
        launchInShell: true,
      },
      callbacks,
    )

    expect(gateway.getShellPath).not.toHaveBeenCalled()
    expect(gateway.buildPtyCommand).toHaveBeenCalledWith({
      binaryPath: 'C:\\bin\\claude.exe',
      args: ['entry.js', '--', 'hi'],
      rows: 30,
      cols: 120,
      transcriptPath: 'C:\\Temp\\run-7.log',
      thenShell: true,
    })
    expect(broker.start).toHaveBeenCalledWith(
      'ai-run-7',
      {
        command: 'C:\\Windows\\powershell.exe',
        args: ['-NoLogo', '-Command', 'host-loader'],
        cwd: 'C:\\vault',
        env: {
          Path: 'C:\\Windows',
          FORCE_COLOR: '1',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TASKCHUTE_CONPTY_COMMAND_LINE: 'claude.exe -- hi',
        },
        stdinMode: 'pipe',
        controlPipe: true,
      },
      'C:\\Temp\\run-7.log',
      undefined,
      relayedCallbacks,
    )

    // Keys and sizes go to the broker as usual; its guard frames them.
    handle.write('x')
    handle.resize?.(100, 40)
    expect(broker.write).toHaveBeenCalledWith('ai-run-7', 'x')
    expect(broker.resize).toHaveBeenCalledWith('ai-run-7', 100, 40)
  })

  test('on Windows a plain shell session gets no PowerShell after it', () => {
    const gateway = {
      getPtyTransport: jest.fn(() => 'conpty'),
      buildPtyCommand: jest.fn(() => ({ command: 'powershell.exe', args: [] })),
      getBaseEnv: jest.fn(() => ({})),
    } as unknown as ProcessGateway
    const dispatcher = new BrokerTerminalDispatcher(
      gateway,
      makeBroker() as unknown as TerminalSessionBrokerClient,
    )

    dispatcher.start(
      {
        binaryPath: 'C:\\Windows\\pwsh.exe',
        prompt: '',
        rows: 24,
        cols: 80,
        transcriptPath: 'C:\\Temp\\shell.log',
      },
      { onData: jest.fn(), onExit: jest.fn() },
    )

    expect(gateway.buildPtyCommand).toHaveBeenCalledWith(
      expect.not.objectContaining({ thenShell: expect.anything() }),
    )
  })

  test('reattaches by stable session id and exposes transport lifecycle', async () => {
    const broker = makeBroker()
    const dispatcher = new BrokerTerminalDispatcher(
      makeGateway(),
      broker as unknown as TerminalSessionBrokerClient,
    )
    const callbacks = {
      onData: jest.fn(),
      onExit: jest.fn(),
      onUnavailable: jest.fn(),
    }

    const handle = dispatcher.attach(
      'ai-run-restored',
      callbacks,
    )
    dispatcher.detach()
    await dispatcher.scheduleShutdownAfterGrace(15_000)
    await dispatcher.cancelDeferredShutdown()
    await dispatcher.setRendererLeaseToken('renderer-lease-2')
    await dispatcher.shutdown()

    expect(dispatcher.isPersistent).toBe(true)
    expect(handle.sessionId).toBe('ai-run-restored')
    expect(broker.attach).toHaveBeenCalledWith('ai-run-restored', callbacks)
    expect(broker.detach).toHaveBeenCalledTimes(1)
    expect(broker.scheduleShutdownAfterGrace).toHaveBeenCalledWith(15_000)
    expect(broker.cancelDeferredShutdown).toHaveBeenCalledTimes(1)
    expect(broker.setRendererLeaseToken).toHaveBeenCalledWith(
      'renderer-lease-2',
      undefined,
      undefined,
    )
    expect(broker.shutdown).toHaveBeenCalledTimes(1)
  })

  test('forwards the complete captured renderer identity for delayed controls', async () => {
    const broker = makeBroker()
    const dispatcher = new BrokerTerminalDispatcher(
      makeGateway(),
      broker as unknown as TerminalSessionBrokerClient,
    )

    await dispatcher.scheduleShutdownAfterGrace(
      15_000,
      'renderer-lease-2',
      'renderer-owner',
      2,
    )
    await dispatcher.cancelDeferredShutdown(
      'renderer-lease-2',
      'renderer-owner',
      2,
    )
    await dispatcher.setRendererLeaseToken(
      'renderer-lease-3',
      'renderer-owner',
      3,
    )

    expect(broker.scheduleShutdownAfterGrace).toHaveBeenCalledWith(
      15_000,
      'renderer-lease-2',
      'renderer-owner',
      2,
    )
    expect(broker.cancelDeferredShutdown).toHaveBeenCalledWith(
      'renderer-lease-2',
      'renderer-owner',
      2,
    )
    expect(broker.setRendererLeaseToken).toHaveBeenCalledWith(
      'renderer-lease-3',
      'renderer-owner',
      3,
    )
  })

  describe('when the broker refuses a session for reasons of its own (LEV-405)', () => {
    const refused = (message: string): AiRunExitOutcome => ({
      status: 'failed',
      exitCode: null,
      signal: null,
      errorMessage: message,
      terminalFailure: 'broker-refused',
    })
    const OWNERSHIP = 'Terminal root ownership identity could not be recorded'
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    function startSession(
      { mayReplaceBroker }: { mayReplaceBroker?: () => boolean } = { mayReplaceBroker: () => true },
    ) {
      const broker = makeBroker()
      const dispatcher = new BrokerTerminalDispatcher(
        makeGateway(),
        broker as unknown as TerminalSessionBrokerClient,
      )
      const callbacks = { onData: jest.fn(), onExit: jest.fn() }
      const handle = dispatcher.start(
        {
          sessionId: 'ai-run-9',
          binaryPath: '/bin/zsh',
          prompt: '',
          cwd: '/vault',
          extraArgs: [],
          rows: 24,
          cols: 80,
          transcriptPath: '/tmp/run-9.log',
          ...(mayReplaceBroker ? { mayReplaceBroker } : {}),
        },
        callbacks,
      )
      return { broker, callbacks, handle }
    }

    test('starts it once more, with the same id, on a new broker', async () => {
      const { broker, callbacks } = startSession()
      startCallbacks(broker, 0).onExit(refused(OWNERSHIP))
      await flush()

      expect(broker.replaceBroker).toHaveBeenCalledTimes(1)
      expect(broker.start).toHaveBeenCalledTimes(2)
      expect(broker.start.mock.calls[1][0]).toBe('ai-run-9')
      expect(broker.start.mock.calls[1][1]).toEqual(broker.start.mock.calls[0][1])
      expect(callbacks.onExit).not.toHaveBeenCalled()

      startCallbacks(broker, 1).onData('ready')
      expect(callbacks.onData).toHaveBeenCalledWith('ready')
    })

    test('reports the second refusal instead of trying again', async () => {
      const { broker, callbacks } = startSession()
      startCallbacks(broker, 0).onExit(refused(OWNERSHIP))
      await flush()
      const second = refused('Terminal session process could not be started with /usr/bin/node')
      startCallbacks(broker, 1).onExit(second)
      await flush()

      expect(broker.replaceBroker).toHaveBeenCalledTimes(1)
      expect(broker.start).toHaveBeenCalledTimes(2)
      expect(callbacks.onExit).toHaveBeenCalledWith(second)
    })

    test('leaves the broker alone while another session of this window runs on it', async () => {
      const { broker, callbacks } = startSession()
      broker.hasSessions.mockReturnValue(true)
      const outcome = refused(OWNERSHIP)
      startCallbacks(broker, 0).onExit(outcome)
      await flush()

      expect(broker.replaceBroker).not.toHaveBeenCalled()
      expect(callbacks.onExit).toHaveBeenCalledWith(outcome)
    })

    test.each([
      ['another terminal of this window runs (a hot reload left it on the previous client)', { mayReplaceBroker: () => false }],
      ['the caller cannot tell', {}],
    ])('leaves the broker alone when %s', async (_case, options) => {
      const { broker, callbacks } = startSession(options)
      const outcome = refused(OWNERSHIP)
      startCallbacks(broker, 0).onExit(outcome)
      await flush()

      expect(broker.replaceBroker).not.toHaveBeenCalled()
      expect(callbacks.onExit).toHaveBeenCalledWith(outcome)
    })

    test('does not retry a refusal any broker would repeat', async () => {
      const { broker, callbacks } = startSession()
      const outcome = refused('Invalid spawn request')
      startCallbacks(broker, 0).onExit(outcome)
      await flush()

      expect(broker.replaceBroker).not.toHaveBeenCalled()
      expect(callbacks.onExit).toHaveBeenCalledWith(outcome)
    })

    test('does not start again a session stopped while the broker was replaced', async () => {
      const { broker, callbacks, handle } = startSession()
      let finishReplacement = (): void => {}
      broker.replaceBroker.mockReturnValue(
        new Promise<void>((resolve) => {
          finishReplacement = resolve
        }),
      )
      const outcome = refused(OWNERSHIP)
      startCallbacks(broker, 0).onExit(outcome)
      handle.stop()
      finishReplacement()
      await flush()

      expect(broker.start).toHaveBeenCalledTimes(1)
      expect(callbacks.onExit).toHaveBeenCalledWith(outcome)
    })

    test('reports the refusal when the old broker cannot be stopped', async () => {
      const { broker, callbacks } = startSession()
      broker.replaceBroker.mockRejectedValue(new Error('Terminal broker could not be replaced'))
      const outcome = refused(OWNERSHIP)
      startCallbacks(broker, 0).onExit(outcome)
      await flush()

      expect(broker.start).toHaveBeenCalledTimes(1)
      expect(callbacks.onExit).toHaveBeenCalledWith(outcome)
    })
  })
})
