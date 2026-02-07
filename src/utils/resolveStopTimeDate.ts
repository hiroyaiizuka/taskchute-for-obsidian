export type StopTimeDateResolution =
  | { type: 'same-day' }
  | { type: 'next-day' }
  | { type: 'disambiguate'; sameDayDate: Date; nextDayDate: Date }
  | { type: 'error'; reason: 'same-time' | 'both-future' }

export interface ResolveStopTimeDateParams {
  startTime: Date
  stopTimeStr: string // "HH:MM"
  now: Date
  wasCrossDay: boolean
}

export function resolveStopTimeDate(params: ResolveStopTimeDateParams): StopTimeDateResolution {
  const { startTime, stopTimeStr, now, wasCrossDay } = params
  const [stopH, stopM] = stopTimeStr.split(':').map((n) => parseInt(n, 10))
  const startMinutes = startTime.getHours() * 60 + startTime.getMinutes()
  const stopMinutes = stopH * 60 + stopM

  // 1. Same time -> error
  if (startMinutes === stopMinutes) {
    return { type: 'error', reason: 'same-time' }
  }

  // 2. stop < start (in HH:MM) -> always next-day (no ambiguity)
  if (startMinutes > stopMinutes) {
    return { type: 'next-day' }
  }

  // 3. stop > start && not originally cross-day -> same-day (no ambiguity)
  if (!wasCrossDay) {
    return { type: 'same-day' }
  }

  // 4. stop > start && wasCrossDay -> ambiguous case
  // Build two candidates
  const candidateA = new Date(
    startTime.getFullYear(),
    startTime.getMonth(),
    startTime.getDate(),
    stopH,
    stopM,
    0,
    0,
  )
  const candidateB = new Date(
    startTime.getFullYear(),
    startTime.getMonth(),
    startTime.getDate() + 1,
    stopH,
    stopM,
    0,
    0,
  )

  const aIsPast = candidateA.getTime() <= now.getTime()
  const bIsPast = candidateB.getTime() <= now.getTime()

  if (aIsPast && !bIsPast) {
    return { type: 'same-day' }
  }
  if (!aIsPast && bIsPast) {
    return { type: 'next-day' }
  }
  if (aIsPast && bIsPast) {
    return { type: 'disambiguate', sameDayDate: candidateA, nextDayDate: candidateB }
  }

  // Both future
  return { type: 'error', reason: 'both-future' }
}
