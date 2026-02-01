/**
 * executionLogUtils のテスト
 *
 * TDD原則に基づいて、以下の修正箇所をテスト：
 * 1. parseTaskLogSnapshot の throwOnError オプション
 */
import {
  parseTaskLogSnapshot,
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
} from '../../src/utils/executionLogUtils'
import type { TaskLogEntry } from '../../src/types/ExecutionLog'

describe('parseTaskLogSnapshot', () => {
  describe('basic parsing', () => {
    test('returns empty snapshot for null input', () => {
      const result = parseTaskLogSnapshot(null)

      expect(result.taskExecutions).toEqual({})
      expect(result.dailySummary).toEqual({})
      expect(result.meta.revision).toBe(0)
    })

    test('returns empty snapshot for undefined input', () => {
      const result = parseTaskLogSnapshot(undefined)

      expect(result.taskExecutions).toEqual({})
      expect(result.dailySummary).toEqual({})
    })

    test('returns empty snapshot for empty string', () => {
      const result = parseTaskLogSnapshot('')

      expect(result.taskExecutions).toEqual({})
      expect(result.dailySummary).toEqual({})
    })

    test('parses valid JSON correctly', () => {
      const input = JSON.stringify({
        taskExecutions: {
          '2026-01-30': [
            { instanceId: 'inst-1', taskTitle: 'Task 1' },
          ],
        },
        dailySummary: {
          '2026-01-30': { totalTasks: 5, completedTasks: 3 },
        },
        meta: {
          revision: 10,
          lastProcessedAt: '2026-01-30T10:00:00Z',
        },
      })

      const result = parseTaskLogSnapshot(input)

      expect(result.taskExecutions['2026-01-30']).toHaveLength(1)
      expect(result.dailySummary['2026-01-30'].totalTasks).toBe(5)
      expect(result.meta.revision).toBe(10)
    })
  })

  describe('error handling', () => {
    test('returns empty snapshot on parse error by default', () => {
      const invalidJson = '{ invalid json }'

      const result = parseTaskLogSnapshot(invalidJson)

      expect(result.taskExecutions).toEqual({})
      expect(result.dailySummary).toEqual({})
    })

    test('throws error on parse error when throwOnError is true', () => {
      const invalidJson = '{ invalid json }'

      expect(() => {
        parseTaskLogSnapshot(invalidJson, { throwOnError: true })
      }).toThrow()
    })

    test('does not throw on parse error when throwOnError is false', () => {
      const invalidJson = '{ invalid json }'

      expect(() => {
        parseTaskLogSnapshot(invalidJson, { throwOnError: false })
      }).not.toThrow()

      const result = parseTaskLogSnapshot(invalidJson, { throwOnError: false })
      expect(result.taskExecutions).toEqual({})
    })

    test('does not throw on parse error when options is undefined', () => {
      const invalidJson = '{ invalid json }'

      expect(() => {
        parseTaskLogSnapshot(invalidJson)
      }).not.toThrow()
    })
  })

  describe('meta field normalization', () => {
    test('provides default meta values when not present', () => {
      const input = JSON.stringify({
        taskExecutions: {},
        dailySummary: {},
      })

      const result = parseTaskLogSnapshot(input)

      expect(result.meta.revision).toBe(0)
      expect(result.meta.processedCursor).toEqual({})
      expect(result.meta.lastBackupAt).toBeUndefined()
    })

    test('preserves processedCursor when present', () => {
      const input = JSON.stringify({
        taskExecutions: {},
        dailySummary: {},
        meta: {
          processedCursor: {
            'device-1': 100,
            'device-2': 200,
          },
        },
      })

      const result = parseTaskLogSnapshot(input)

      expect(result.meta.processedCursor).toEqual({
        'device-1': 100,
        'device-2': 200,
      })
    })
  })
})

describe('createEmptyTaskLogSnapshot', () => {
  test('creates a new empty snapshot each time', () => {
    const snapshot1 = createEmptyTaskLogSnapshot()
    const snapshot2 = createEmptyTaskLogSnapshot()

    // Should be equal but not the same reference
    expect(snapshot1).toEqual(snapshot2)
    expect(snapshot1).not.toBe(snapshot2)
  })

  test('has correct initial values', () => {
    const snapshot = createEmptyTaskLogSnapshot()

    expect(snapshot.taskExecutions).toEqual({})
    expect(snapshot.dailySummary).toEqual({})
    expect(snapshot.meta.revision).toBe(0)
    expect(snapshot.meta.processedCursor).toEqual({})
  })
})

describe('isExecutionLogEntryCompleted', () => {
  test('returns true when isCompleted is true', () => {
    const entry: TaskLogEntry = {
      instanceId: 'inst-1',
      isCompleted: true,
    }

    expect(isExecutionLogEntryCompleted(entry)).toBe(true)
  })

  test('returns false when isCompleted is false', () => {
    const entry: TaskLogEntry = {
      instanceId: 'inst-1',
      isCompleted: false,
    }

    expect(isExecutionLogEntryCompleted(entry)).toBe(false)
  })

  test('returns true when stopTime is present', () => {
    const entry: TaskLogEntry = {
      instanceId: 'inst-1',
      stopTime: '10:00',
    }

    expect(isExecutionLogEntryCompleted(entry)).toBe(true)
  })

  test('returns true when durationSec is positive', () => {
    const entry: TaskLogEntry = {
      instanceId: 'inst-1',
      durationSec: 3600,
    }

    expect(isExecutionLogEntryCompleted(entry)).toBe(true)
  })
})

describe('minutesFromLogEntries', () => {
  test('calculates total minutes from durationSec', () => {
    const entries: TaskLogEntry[] = [
      { instanceId: 'inst-1', durationSec: 3600 }, // 60 minutes
      { instanceId: 'inst-2', durationSec: 1800 }, // 30 minutes
    ]

    expect(minutesFromLogEntries(entries)).toBe(90)
  })

  test('returns 0 for empty array', () => {
    expect(minutesFromLogEntries([])).toBe(0)
  })

  test('handles entries without duration', () => {
    const entries: TaskLogEntry[] = [
      { instanceId: 'inst-1' },
      { instanceId: 'inst-2', durationSec: 600 },
    ]

    expect(minutesFromLogEntries(entries)).toBe(10)
  })
})
