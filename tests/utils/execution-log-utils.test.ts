import {
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
  parseTaskLogSnapshot,
  parseCursorSnapshotRevision,
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

  test('parseTaskLogSnapshot preserves cursorSnapshotRevision', () => {
    const raw = JSON.stringify({
      taskExecutions: {},
      dailySummary: {},
      meta: {
        revision: 5,
        processedCursor: { 'device-a': 3 },
        cursorSnapshotRevision: { 'device-a': 5, 'device-b': 4 },
      },
    })
    const snapshot = parseTaskLogSnapshot(raw)
    expect(snapshot.meta?.cursorSnapshotRevision).toEqual({ 'device-a': 5, 'device-b': 4 })
  })

  test('parseTaskLogSnapshot returns undefined cursorSnapshotRevision for old snapshots', () => {
    const raw = JSON.stringify({
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 1, processedCursor: {} },
    })
    const snapshot = parseTaskLogSnapshot(raw)
    expect(snapshot.meta?.cursorSnapshotRevision).toBeUndefined()
  })

  test('parseCursorSnapshotRevision validates number types', () => {
    expect(parseCursorSnapshotRevision(undefined)).toBeUndefined()
    expect(parseCursorSnapshotRevision(null)).toBeUndefined()
    expect(parseCursorSnapshotRevision({})).toBeUndefined()
    expect(parseCursorSnapshotRevision({ a: 'not-a-number' })).toBeUndefined()
    expect(parseCursorSnapshotRevision({ a: 1, b: NaN })).toEqual({ a: 1 })
    expect(parseCursorSnapshotRevision({ a: 1, b: Infinity })).toEqual({ a: 1 })
    expect(parseCursorSnapshotRevision({ a: 3, b: 5 })).toEqual({ a: 3, b: 5 })
  })
})

describe('parseCursorSnapshotRevision', () => {
  it('returns undefined for null/undefined/non-object', () => {
    expect(parseCursorSnapshotRevision(null)).toBeUndefined()
    expect(parseCursorSnapshotRevision(undefined)).toBeUndefined()
    expect(parseCursorSnapshotRevision('string')).toBeUndefined()
    expect(parseCursorSnapshotRevision(123)).toBeUndefined()
  })

  it('parses valid numeric entries', () => {
    const result = parseCursorSnapshotRevision({ 'device-a': 5, 'device-b': 10 })
    expect(result).toEqual({ 'device-a': 5, 'device-b': 10 })
  })

  it('skips non-numeric entries', () => {
    const result = parseCursorSnapshotRevision({ 'device-a': 5, 'device-b': 'invalid', 'device-c': null })
    expect(result).toEqual({ 'device-a': 5 })
  })

  it('returns undefined for empty object', () => {
    expect(parseCursorSnapshotRevision({})).toBeUndefined()
  })

  it('skips non-finite numbers', () => {
    const result = parseCursorSnapshotRevision({ 'device-a': Infinity, 'device-b': NaN, 'device-c': 3 })
    expect(result).toEqual({ 'device-c': 3 })
  })
})

describe('parseTaskLogSnapshot cursorSnapshotRevision', () => {
  it('preserves cursorSnapshotRevision from raw JSON', () => {
    const raw = JSON.stringify({
      taskExecutions: {},
      dailySummary: {},
      meta: {
        revision: 5,
        processedCursor: { 'dev-1': 10 },
        cursorSnapshotRevision: { 'dev-1': 5 },
      },
    })
    const snapshot = parseTaskLogSnapshot(raw)
    expect(snapshot.meta?.cursorSnapshotRevision).toEqual({ 'dev-1': 5 })
  })

  it('returns undefined cursorSnapshotRevision when not present in raw', () => {
    const raw = JSON.stringify({
      taskExecutions: {},
      dailySummary: {},
      meta: { revision: 3, processedCursor: {} },
    })
    const snapshot = parseTaskLogSnapshot(raw)
    expect(snapshot.meta?.cursorSnapshotRevision).toBeUndefined()
  })
})
