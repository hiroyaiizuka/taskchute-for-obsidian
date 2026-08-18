import {
  AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY,
  AiTaskAmbientScheduleStateStore,
  formatAiTaskAmbientDateKey,
  resolveAiTaskAmbientIdentity,
} from '../../../src/features/ai-task/services/AiTaskAmbientScheduleStateStore'

describe('AiTaskAmbientScheduleStateStore', () => {
  test('uses taskId across path changes and falls back to path for legacy tasks', () => {
    expect(
      resolveAiTaskAmbientIdentity({
        taskId: '  task-123  ',
        path: 'TaskChute/Task/Before.md',
      }),
    ).toBe('taskId:task-123')
    expect(
      resolveAiTaskAmbientIdentity({ path: ' TaskChute/Task/Legacy.md ' }),
    ).toBe('path:TaskChute/Task/Legacy.md')
    expect(resolveAiTaskAmbientIdentity({ taskId: ' ', path: ' ' })).toBeNull()
  })

  test('formats date keys in local time', () => {
    expect(formatAiTaskAmbientDateKey(new Date(2026, 6, 15, 23, 59))).toBe(
      '2026-07-15',
    )
  })

  test('marks one local date and permits the same routine on the next date', () => {
    let stored: unknown = null
    const saveLocalStorage = jest.fn((_key: string, value: unknown) => {
      stored = value
    })
    const store = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => stored,
      saveLocalStorage,
    })

    expect(store.isExecuted('taskId:daily', '2026-07-15')).toBe(false)
    expect(
      store.markExecuted(
        'taskId:daily',
        '2026-07-15',
        new Date(2026, 6, 15, 8, 0),
      ),
    ).toBe(true)
    expect(store.isExecuted('taskId:daily', '2026-07-15')).toBe(true)
    expect(store.isExecuted('taskId:daily', '2026-07-16')).toBe(false)
    expect(saveLocalStorage).toHaveBeenCalledWith(
      AI_TASK_AMBIENT_SCHEDULE_STATE_STORAGE_KEY,
      expect.objectContaining({ version: 1 }),
    )

    const reloaded = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => stored,
      saveLocalStorage: jest.fn(),
    })
    expect(reloaded.isExecuted('taskId:daily', '2026-07-15')).toBe(true)
  })

  test('filters corrupt records without throwing', () => {
    const store = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => ({
        version: 99,
        executions: {
          good: {
            lastExecutedDate: '2026-07-15',
            lastExecutedAt: '2026-07-15T08:00:00.000Z',
          },
          badDate: {
            lastExecutedDate: '2026-02-31',
            lastExecutedAt: '2026-02-01T00:00:00.000Z',
          },
          badTimestamp: {
            lastExecutedDate: '2026-07-15',
            lastExecutedAt: 'not-a-date',
          },
          badShape: 42,
        },
      }),
      saveLocalStorage: jest.fn(),
    })

    expect(store.isExecuted('good', '2026-07-15')).toBe(true)
    expect(store.snapshot().executions).toEqual({
      good: {
        lastExecutedDate: '2026-07-15',
        lastExecutedAt: '2026-07-15T08:00:00.000Z',
      },
    })
  })

  test('prunes records older than 30 days and keeps the cutoff date', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => ({
        version: 1,
        executions: {
          old: {
            lastExecutedDate: '2026-06-14',
            lastExecutedAt: '2026-06-14T00:00:00.000Z',
          },
          cutoff: {
            lastExecutedDate: '2026-06-15',
            lastExecutedAt: '2026-06-15T00:00:00.000Z',
          },
          recent: {
            lastExecutedDate: '2026-07-14',
            lastExecutedAt: '2026-07-14T00:00:00.000Z',
          },
        },
      }),
      saveLocalStorage,
    })

    expect(store.prune(new Date(2026, 6, 15))).toBe(1)
    expect(Object.keys(store.snapshot().executions)).toEqual([
      'cutoff',
      'recent',
    ])
    expect(saveLocalStorage).toHaveBeenCalledTimes(1)
  })

  test('keeps the in-memory once-per-day guard when local storage is unavailable', () => {
    const store = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => {
        throw new Error('unavailable')
      },
      saveLocalStorage: () => {
        throw new Error('unavailable')
      },
    })

    expect(() =>
      store.markExecuted(
        'taskId:offline',
        '2026-07-15',
        new Date(2026, 6, 15, 8, 0),
      ),
    ).not.toThrow()
    expect(store.isExecuted('taskId:offline', '2026-07-15')).toBe(true)
  })

  test('rejects invalid identities, date keys, and timestamps', () => {
    const saveLocalStorage = jest.fn()
    const store = new AiTaskAmbientScheduleStateStore({
      loadLocalStorage: () => null,
      saveLocalStorage,
    })

    expect(store.markExecuted(' ', '2026-07-15')).toBe(false)
    expect(store.markExecuted('taskId:x', '2026-02-31')).toBe(false)
    expect(
      store.markExecuted('taskId:x', '2026-07-15', new Date('invalid')),
    ).toBe(false)
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })
})
