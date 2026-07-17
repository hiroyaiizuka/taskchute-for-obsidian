import type { ProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'
import { BrokerTerminalDispatcher } from '../../../src/features/ai-task/services/dispatchers/BrokerTerminalDispatcher'
import type { TerminalSessionBrokerClient } from '../../../src/features/ai-task/services/TerminalSessionBroker'

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
    'start' | 'attach' | 'write' | 'resize' | 'stop' | 'detach' | 'shutdown'
  >
> {
  return {
    start: jest.fn(),
    attach: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    stop: jest.fn(),
    detach: jest.fn(),
    shutdown: jest.fn(),
  }
}

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
      args: ['-i', '-l'],
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
      "'/opt/homebrew/bin/claude' '--model' 'fable' '--' 'say hello'\r",
      callbacks,
    )

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
    await dispatcher.shutdown()

    expect(dispatcher.isPersistent).toBe(true)
    expect(handle.sessionId).toBe('ai-run-restored')
    expect(broker.attach).toHaveBeenCalledWith('ai-run-restored', callbacks)
    expect(broker.detach).toHaveBeenCalledTimes(1)
    expect(broker.shutdown).toHaveBeenCalledTimes(1)
  })
})
