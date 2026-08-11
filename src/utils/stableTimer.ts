export type StableIntervalId = number

export interface StableTimerSource {
  setInterval(callback: () => void, intervalMs: number): StableIntervalId
  clearInterval(intervalId: StableIntervalId): void
}

type StableIntervalRecord = {
  timerWindow: Window
  nativeIntervalId: number
}

const intervalRecords = new Map<StableIntervalId, StableIntervalRecord>()
let nextStableIntervalId: StableIntervalId = -1

function getStableTimerWindow(): Window {
  return window
}

function createStableIntervalId(): StableIntervalId {
  const intervalId = nextStableIntervalId
  nextStableIntervalId -= 1
  return intervalId
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

export function sleepWithStableTimer(ms: number): Promise<void> {
  const timerWindow = getStableTimerWindow()
  return new Promise((resolve) => {
    timerWindow.setTimeout(resolve, ms)
  })
}
