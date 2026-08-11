import { TimerService } from '../../src/services/TimerService'

type TimerWindow = Window & {
  setInterval: jest.Mock<number, [TimerHandler, number?]>
  clearInterval: jest.Mock<void, [number]>
}

const setActiveWindow = (win: TimerWindow): void => {
  ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = win
}

const createTimerWindow = (intervalId: number): TimerWindow => (
  {
    setInterval: jest.fn(() => intervalId),
    clearInterval: jest.fn(),
  } as unknown as TimerWindow
)

describe('TimerService', () => {
  let originalActiveWindow: Window

  beforeEach(() => {
    originalActiveWindow = activeWindow
  })

  afterEach(() => {
    ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = originalActiveWindow
  })

  test('clears an interval on the same Window that created it', () => {
    const sourceWindow = createTimerWindow(42)
    const focusedWindow = createTimerWindow(99)
    const service = new TimerService({
      getRunningInstances: () => [],
      onTick: jest.fn(),
      intervalMs: 250,
    })

    setActiveWindow(sourceWindow)
    service.start()

    setActiveWindow(focusedWindow)
    service.stop()

    expect(sourceWindow.setInterval).toHaveBeenCalledTimes(1)
    expect(sourceWindow.clearInterval).toHaveBeenCalledWith(42)
    expect(focusedWindow.clearInterval).not.toHaveBeenCalled()
    expect(service.isRunning()).toBe(false)
  })
})
