type StableTimerModule = typeof import('../../src/utils/stableTimer')

type TimerWindowMock = Window & {
  setInterval: jest.Mock<number, [TimerHandler, number?]>
  clearInterval: jest.Mock<void, [number?]>
  setTimeout: jest.Mock<number, [TimerHandler, number?]>
}

const setActiveWindow = (win: Window): void => {
  ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow = win
}

const loadStableTimerModule = async (): Promise<StableTimerModule> => {
  jest.resetModules()
  return import('../../src/utils/stableTimer')
}

const createTimerWindow = (ids: { intervalId?: number; timeoutId?: number } = {}): TimerWindowMock => {
  const intervalId = ids.intervalId ?? 1
  const timeoutId = ids.timeoutId ?? 2
  return {
    setInterval: jest.fn(() => intervalId),
    clearInterval: jest.fn(),
    setTimeout: jest.fn((handler) => {
      if (typeof handler === 'function') {
        handler()
      }
      return timeoutId
    }),
  } as unknown as TimerWindowMock
}

describe('stableTimerSource', () => {
  let originalActiveWindow: Window

  beforeEach(() => {
    originalActiveWindow = activeWindow
  })

  afterEach(() => {
    setActiveWindow(originalActiveWindow)
    jest.restoreAllMocks()
  })

  test('does not capture activeWindow at import time and clears the timer source that created the interval', async () => {
    const importTimeWindow = createTimerWindow({ intervalId: 11 })
    const focusedWindow = createTimerWindow({ intervalId: 99 })
    const stableSetInterval = jest.spyOn(window, 'setInterval').mockImplementation(() => 41)
    const stableClearInterval = jest.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const callback = jest.fn()

    setActiveWindow(importTimeWindow)
    const { stableTimerSource } = await loadStableTimerModule()

    setActiveWindow(focusedWindow)
    const intervalId = stableTimerSource.setInterval(callback, 5000)

    expect(importTimeWindow.setInterval).not.toHaveBeenCalled()
    expect(focusedWindow.setInterval).not.toHaveBeenCalled()
    expect(stableSetInterval).toHaveBeenCalledWith(callback, 5000)

    stableTimerSource.clearInterval(intervalId)

    expect(stableClearInterval).toHaveBeenCalledWith(41)
    expect(importTimeWindow.clearInterval).not.toHaveBeenCalled()
    expect(focusedWindow.clearInterval).not.toHaveBeenCalled()
  })

  test('keeps stable interval IDs separate from native interval IDs used by fallback clear', async () => {
    const stableSetInterval = jest.spyOn(window, 'setInterval').mockImplementation(() => 41)
    const stableClearInterval = jest.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const { stableTimerSource } = await loadStableTimerModule()

    const stableIntervalId = stableTimerSource.setInterval(jest.fn(), 5000)

    expect(stableSetInterval).toHaveBeenCalledWith(expect.any(Function), 5000)
    expect(stableIntervalId).not.toBe(1)

    stableTimerSource.clearInterval(1)

    expect(stableClearInterval).toHaveBeenCalledWith(1)
    expect(stableClearInterval).not.toHaveBeenCalledWith(41)

    stableTimerSource.clearInterval(stableIntervalId)

    expect(stableClearInterval).toHaveBeenCalledWith(41)
  })

  test('sleep does not bind to import-time or current activeWindow', async () => {
    const importTimeWindow = createTimerWindow({ timeoutId: 11 })
    const focusedWindow = createTimerWindow({ timeoutId: 99 })
    const stableSetTimeout = jest.spyOn(window, 'setTimeout').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        handler()
      }
      return 42
    })

    setActiveWindow(importTimeWindow)
    const { sleepWithStableTimer } = await loadStableTimerModule()

    setActiveWindow(focusedWindow)
    const sleepPromise = sleepWithStableTimer(25)

    expect(importTimeWindow.setTimeout).not.toHaveBeenCalled()
    expect(focusedWindow.setTimeout).not.toHaveBeenCalled()
    expect(stableSetTimeout).toHaveBeenCalledWith(expect.any(Function), 25)

    await sleepPromise
  })
})
