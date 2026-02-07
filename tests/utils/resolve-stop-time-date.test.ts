import { resolveStopTimeDate, ResolveStopTimeDateParams } from '../../src/utils/resolveStopTimeDate'

describe('resolveStopTimeDate', () => {
  // Helper: create a Date at a specific day/time
  const makeDate = (year: number, month: number, day: number, hours: number, minutes: number): Date =>
    new Date(year, month - 1, day, hours, minutes, 0, 0)

  test('stop < start (stopMinutes < startMinutes) returns next-day regardless of wasCrossDay', () => {
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 22, 0),
      stopTimeStr: '01:00',
      now: makeDate(2025, 10, 2, 9, 0),
      wasCrossDay: false,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'next-day' })
  })

  test('stop > start, non-cross-day returns same-day', () => {
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 10, 0),
      stopTimeStr: '11:00',
      now: makeDate(2025, 10, 1, 12, 0),
      wasCrossDay: false,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'same-day' })
  })

  test('cross-day task, next-day candidate is future -> auto same-day', () => {
    // start=Day1 22:00, stop="22:30", now=Day2 09:00
    // candidateA = Day1 22:30 (past) -> ok
    // candidateB = Day2 22:30 (future) -> not ok
    // Only A is past -> same-day
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 22, 0),
      stopTimeStr: '22:30',
      now: makeDate(2025, 10, 2, 9, 0),
      wasCrossDay: true,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'same-day' })
  })

  test('cross-day task, both candidates in past -> disambiguate', () => {
    // start=Day1 22:00, stop="22:30", now=Day2 23:00
    // candidateA = Day1 22:30 (past)
    // candidateB = Day2 22:30 (past)
    // Both past -> disambiguate
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 22, 0),
      stopTimeStr: '22:30',
      now: makeDate(2025, 10, 2, 23, 0),
      wasCrossDay: true,
    }
    const result = resolveStopTimeDate(params)
    expect(result.type).toBe('disambiguate')
    if (result.type === 'disambiguate') {
      expect(result.sameDayDate.getDate()).toBe(1)
      expect(result.sameDayDate.getHours()).toBe(22)
      expect(result.sameDayDate.getMinutes()).toBe(30)
      expect(result.nextDayDate.getDate()).toBe(2)
      expect(result.nextDayDate.getHours()).toBe(22)
      expect(result.nextDayDate.getMinutes()).toBe(30)
    }
  })

  test('start == stop returns error same-time', () => {
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 10, 0),
      stopTimeStr: '10:00',
      now: makeDate(2025, 10, 1, 12, 0),
      wasCrossDay: false,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'error', reason: 'same-time' })
  })

  test('both candidates future returns error both-future', () => {
    // start=Day1 22:00, stop="23:00", now=Day1 21:00
    // candidateA = Day1 23:00 (future)
    // candidateB = Day2 23:00 (future)
    // Both future -> error
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 22, 0),
      stopTimeStr: '23:00',
      now: makeDate(2025, 10, 1, 21, 0),
      wasCrossDay: true,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'error', reason: 'both-future' })
  })

  test('non-cross-day, stop < start returns next-day', () => {
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 14, 0),
      stopTimeStr: '02:00',
      now: makeDate(2025, 10, 2, 9, 0),
      wasCrossDay: false,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'next-day' })
  })

  test('cross-day task, only next-day candidate is past -> auto next-day', () => {
    // start=Day1 22:00, stop="01:00", wasCrossDay=true
    // But stopMinutes(60) < startMinutes(1320) -> always next-day
    // This case is caught by the stopMinutes < startMinutes check
    const params: ResolveStopTimeDateParams = {
      startTime: makeDate(2025, 10, 1, 22, 0),
      stopTimeStr: '01:00',
      now: makeDate(2025, 10, 2, 9, 0),
      wasCrossDay: true,
    }
    const result = resolveStopTimeDate(params)
    expect(result).toEqual({ type: 'next-day' })
  })
})
