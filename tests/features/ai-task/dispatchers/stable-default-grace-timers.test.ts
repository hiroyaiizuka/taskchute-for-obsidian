import { ClaudeCodeDispatcher } from '../../../../src/features/ai-task/services/dispatchers/ClaudeCodeDispatcher'
import { STOP_GRACE_MS } from '../../../../src/features/ai-task/services/dispatchers/Dispatcher'
import { TerminalDispatcher } from '../../../../src/features/ai-task/services/dispatchers/TerminalDispatcher'
import type { NodeKillSignal } from '../../../../src/features/ai-task/services/NodeProcessGateway'
import { createSpyGateway } from './dispatcherTestUtils'

type PopoutWindow = Window & {
  setTimeout: jest.Mock<number, [TimerHandler, number?]>
  clearTimeout: jest.Mock<void, [number?]>
}

function createPopoutWindow(): PopoutWindow {
  return {
    setTimeout: jest.fn(() => 999),
    clearTimeout: jest.fn(),
  } as unknown as PopoutWindow
}

function setActiveWindow(win: Window): void {
  ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = win
}

function installInertSpawn(
  gateway: ReturnType<typeof createSpyGateway>,
): jest.Mock<void, [NodeKillSignal]> {
  const kill = jest.fn<void, [NodeKillSignal]>()
  gateway.spawnMock.mockReturnValue({
    pid: 4242,
    onStdout: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill,
    writeStdin: jest.fn(),
  })
  return kill
}

describe('AI dispatcher default grace timers', () => {
  let originalActiveWindow: Window

  beforeEach(() => {
    originalActiveWindow = activeWindow
    jest.useFakeTimers()
  })

  afterEach(() => {
    setActiveWindow(originalActiveWindow)
    jest.useRealTimers()
  })

  test('headless force-kill deadline survives a focused popout closing', () => {
    const focusedPopout = createPopoutWindow()
    const replacementPopout = createPopoutWindow()
    const gateway = createSpyGateway()
    const kill = installInertSpawn(gateway)
    const dispatcher = new ClaudeCodeDispatcher(gateway)

    setActiveWindow(focusedPopout)
    const handle = dispatcher.start(
      { binaryPath: '/bin/claude', prompt: 'test' },
      { onEvent: () => undefined, onExit: () => undefined },
    )
    handle.stop()
    setActiveWindow(replacementPopout)

    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(focusedPopout.setTimeout).not.toHaveBeenCalled()
    expect(replacementPopout.setTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(STOP_GRACE_MS)

    expect(kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  test('terminal force-kill deadline survives a focused popout closing', () => {
    const focusedPopout = createPopoutWindow()
    const replacementPopout = createPopoutWindow()
    const gateway = createSpyGateway()
    const kill = installInertSpawn(gateway)
    const dispatcher = new TerminalDispatcher(gateway)

    setActiveWindow(focusedPopout)
    const handle = dispatcher.start(
      {
        binaryPath: '/bin/claude',
        prompt: '',
        rows: 24,
        cols: 80,
        transcriptPath: '/tmp/stable-default-timer-test.log',
      },
      { onData: () => undefined, onExit: () => undefined },
    )
    handle.stop()
    setActiveWindow(replacementPopout)

    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(focusedPopout.setTimeout).not.toHaveBeenCalled()
    expect(replacementPopout.setTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(STOP_GRACE_MS)

    expect(kill).toHaveBeenLastCalledWith('SIGKILL')
  })
})
