export type StableIntervalId = number
export type StableTimeoutId = number

export interface StableTimerSource {
  setInterval(callback: () => void, intervalMs: number): StableIntervalId
  clearInterval(intervalId: StableIntervalId): void
}

export interface StableTimeoutSource {
  setTimeout(callback: () => void, timeoutMs: number): StableTimeoutId
  clearTimeout(timeoutId: StableTimeoutId): void
}

type StableIntervalRecord = {
  timerWindow: Window
  nativeIntervalId: number
}

type StableTimeoutRecord = {
  timerWindow: Window
  nativeTimeoutId: number
}

const intervalRecords = new Map<StableIntervalId, StableIntervalRecord>()
const timeoutRecords = new Map<StableTimeoutId, StableTimeoutRecord>()
let nextStableIntervalId: StableIntervalId = -1
let nextStableTimeoutId: StableTimeoutId = -1_000_000_000

function getStableTimerWindow(): Window {
  return window
}

function createStableIntervalId(): StableIntervalId {
  const intervalId = nextStableIntervalId
  nextStableIntervalId -= 1
  return intervalId
}

function createStableTimeoutId(): StableTimeoutId {
  const timeoutId = nextStableTimeoutId
  nextStableTimeoutId -= 1
  return timeoutId
}

export const stableTimerSource: StableTimerSource = {
  setInterval: (callback, intervalMs) => {
    const timerWindow = getStableTimerWindow()
    const nativeIntervalId = timerWindow.setInterval(callback, intervalMs)
    const stableIntervalId = createStableIntervalId()
    intervalRecords.set(stableIntervalId, { timerWindow, nativeIntervalId })
    return stableIntervalId
  },
  clearInterval: (intervalId) => {
    const record = intervalRecords.get(intervalId)
    if (!record) {
      getStableTimerWindow().clearInterval(intervalId)
      return
    }
    intervalRecords.delete(intervalId)
    record.timerWindow.clearInterval(record.nativeIntervalId)
  },
}

/**
 * Root-renderer timeout source.
 *
 * Obsidian's `activeWindow` follows focus and may point at a popout that is
 * destroyed before a lifecycle deadline fires. Each timeout records the root
 * window that armed it and always clears through that same owner.
 */
export const stableTimeoutSource: StableTimeoutSource = {
  setTimeout: (callback, timeoutMs) => {
    const timerWindow = getStableTimerWindow()
    const stableTimeoutId = createStableTimeoutId()
    const nativeTimeoutId = timerWindow.setTimeout(() => {
      timeoutRecords.delete(stableTimeoutId)
      callback()
    }, timeoutMs)
    timeoutRecords.set(stableTimeoutId, { timerWindow, nativeTimeoutId })
    return stableTimeoutId
  },
  clearTimeout: (timeoutId) => {
    const record = timeoutRecords.get(timeoutId)
    if (!record) {
      getStableTimerWindow().clearTimeout(timeoutId)
      return
    }
    timeoutRecords.delete(timeoutId)
    record.timerWindow.clearTimeout(record.nativeTimeoutId)
  },
}

export function sleepWithStableTimer(ms: number): Promise<void> {
  const timerWindow = getStableTimerWindow()
  return new Promise((resolve) => {
    timerWindow.setTimeout(resolve, ms)
  })
}
