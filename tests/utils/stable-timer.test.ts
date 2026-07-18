type StableTimerModule = typeof import('../../src/utils/stableTimer')

type TimerWindowMock = Window & {
  setInterval: jest.Mock<number, [TimerHandler, number?]>
  clearInterval: jest.Mock<void, [number?]>
  setTimeout: jest.Mock<number, [TimerHandler, number?]>
  clearTimeout: jest.Mock<void, [number?]>
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
    clearTimeout: jest.fn(),
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

  test('timeout survives a popout focus switch and clears through its root-window owner', async () => {
    const importTimeWindow = createTimerWindow({ timeoutId: 11 })
    const focusedPopout = createTimerWindow({ timeoutId: 99 })
    const laterPopout = createTimerWindow({ timeoutId: 100 })
    let nativeCallback: (() => void) | null = null
    const stableSetTimeout = jest.spyOn(window, 'setTimeout').mockImplementation(
      (handler: TimerHandler) => {
        if (typeof handler === 'function') {
          nativeCallback = handler
        }
        return 42
      },
    )
    const stableClearTimeout = jest
      .spyOn(window, 'clearTimeout')
      .mockImplementation(() => undefined)
    const callback = jest.fn()

    setActiveWindow(importTimeWindow)
    const { stableTimeoutSource } = await loadStableTimerModule()

    setActiveWindow(focusedPopout)
    const timeoutId = stableTimeoutSource.setTimeout(callback, 1500)

    expect(importTimeWindow.setTimeout).not.toHaveBeenCalled()
    expect(focusedPopout.setTimeout).not.toHaveBeenCalled()
    expect(stableSetTimeout).toHaveBeenCalledWith(expect.any(Function), 1500)

    setActiveWindow(laterPopout)
    expect(nativeCallback).not.toBeNull()
    ;(nativeCallback as unknown as () => void)()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(laterPopout.setTimeout).not.toHaveBeenCalled()

    // The fired record is gone; clearing the stable handle must never target
    // either short-lived popout or the native root-window id.
    stableTimeoutSource.clearTimeout(timeoutId)
    expect(importTimeWindow.clearTimeout).not.toHaveBeenCalled()
    expect(focusedPopout.clearTimeout).not.toHaveBeenCalled()
    expect(laterPopout.clearTimeout).not.toHaveBeenCalled()
    expect(stableClearTimeout).toHaveBeenCalledWith(timeoutId)
    expect(stableClearTimeout).not.toHaveBeenCalledWith(42)
  })

  test('cancels an armed timeout through the same root window after activeWindow changes', async () => {
    const focusedPopout = createTimerWindow({ timeoutId: 99 })
    const laterPopout = createTimerWindow({ timeoutId: 100 })
    const stableSetTimeout = jest.spyOn(window, 'setTimeout').mockImplementation(() => 42)
    const stableClearTimeout = jest
      .spyOn(window, 'clearTimeout')
      .mockImplementation(() => undefined)
    const { stableTimeoutSource } = await loadStableTimerModule()

    setActiveWindow(focusedPopout)
    const timeoutId = stableTimeoutSource.setTimeout(jest.fn(), 1500)
    setActiveWindow(laterPopout)
    stableTimeoutSource.clearTimeout(timeoutId)

    expect(stableSetTimeout).toHaveBeenCalledWith(expect.any(Function), 1500)
    expect(stableClearTimeout).toHaveBeenCalledWith(42)
    expect(focusedPopout.clearTimeout).not.toHaveBeenCalled()
    expect(laterPopout.clearTimeout).not.toHaveBeenCalled()
  })
})
