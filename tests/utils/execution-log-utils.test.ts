import {
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
  parseTaskLogSnapshot,
} from '../../src/utils/executionLogUtils'

describe('executionLogUtils', () => {
  test('parseTaskLogSnapshot returns empty snapshot on invalid json', () => {
    const snapshot = parseTaskLogSnapshot('{ invalid json')
    expect(snapshot.taskExecutions).toEqual({})
    expect(snapshot.dailySummary).toEqual({})
  })

  test('isExecutionLogEntryCompleted respects completion flags', () => {
    expect(
      isExecutionLogEntryCompleted({ isCompleted: false, stopTime: '' }),
    ).toBe(false)
    expect(isExecutionLogEntryCompleted({ stopTime: '12:00' })).toBe(true)
    expect(isExecutionLogEntryCompleted({ durationSec: 120 })).toBe(true)
  })

  test('minutesFromLogEntries aggregates minutes', () => {
    const entries = [
      { durationSec: 300 },
      { duration: 120 },
      { durationSec: 59 },
    ]
    expect(minutesFromLogEntries(entries)).toBe(7)
  })

  test('createEmptyTaskLogSnapshot returns isolated objects', () => {
    const a = createEmptyTaskLogSnapshot()
    const b = createEmptyTaskLogSnapshot()
    expect(a).not.toBe(b)
    expect(a.taskExecutions).not.toBe(b.taskExecutions)
    expect(a.dailySummary).not.toBe(b.dailySummary)
  })
})
