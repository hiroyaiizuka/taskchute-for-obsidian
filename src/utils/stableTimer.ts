export type StableIntervalId = number

export interface StableTimerSource {
  setInterval(callback: () => void, intervalMs: number): StableIntervalId
  clearInterval(intervalId: StableIntervalId): void
}

export const stableTimerSource: StableTimerSource = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs) as unknown as StableIntervalId,
  clearInterval: (intervalId) => clearInterval(intervalId),
}

export function sleepWithStableTimer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
