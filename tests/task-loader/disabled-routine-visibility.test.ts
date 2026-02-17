import { createRoutineLoadContext } from '../utils/taskViewTestUtils'

describe('Disabled routine visibility', () => {
  describe('target_date based display', () => {
    test('disabled routine with target_date keeps routine semantics on that date', async () => {
      const today = '2025-09-24'
      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(1)
      expect(context.tasks).toHaveLength(1)
      // Disabled routines must keep routine deletion semantics
      expect(context.taskInstances[0].task.isRoutine).toBe(true)
    })

    test('disabled routine restores slot override from day state', async () => {
      const today = '2025-09-24'
      const { context, load } = createRoutineLoadContext({
        date: today,
        slotOverride: '12:00-16:00',
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(1)
      expect(context.taskInstances[0].slotKey).toBe('12:00-16:00')
    })

    test('disabled routine with target_date is hidden on a different date', async () => {
      const { context, load } = createRoutineLoadContext({
        date: '2025-09-25',
        metadataOverrides: {
          routine_enabled: false,
          target_date: '2025-09-24',
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })
  })

  describe('fallback for existing data without target_date', () => {
    test('disabled routine without target_date shows on today as fallback', async () => {
      // Use today's actual date for the fallback test
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const today = `${y}-${m}-${d}`

      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(1)
      expect(context.tasks).toHaveLength(1)
    })

    test('disabled routine without target_date is hidden on non-today date', async () => {
      // Use a date that is definitely not today
      const { context, load } = createRoutineLoadContext({
        date: '2020-01-01',
        metadataOverrides: {
          routine_enabled: false,
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })
  })

  describe('re-enable routine', () => {
    test('re-enabled routine follows normal schedule', async () => {
      const { context, load } = createRoutineLoadContext({
        date: '2025-09-24',
        metadataOverrides: {
          routine_enabled: true,
        },
      })

      await load()

      expect(context.taskInstances).toHaveLength(1)
      expect(context.tasks).toHaveLength(1)
      expect(context.taskInstances[0].task.isRoutine).toBe(true)
    })
  })

  describe('permanent deletion checks', () => {
    test('taskId-based permanently deleted disabled routine stays hidden', async () => {
      const today = '2025-09-24'
      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
            taskId: 'tc-task-routine',
            timestamp: Date.now(),
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })

    test('promotes legacy path deletion to taskId for disabled routine before stale cleanup', async () => {
      const today = '2025-09-24'
      const deletionTimestamp = new Date(today).getTime() - 1000
      const { context, dayState, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
          taskId: 'tc-task-routine',
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
            timestamp: deletionTimestamp,
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
      expect(dayState.deletedInstances.some((entry) => entry.taskId === 'tc-task-routine')).toBe(true)
    })

    test('taskId-based permanently deleted disabled routine without target_date stays hidden', async () => {
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const today = `${y}-${m}-${d}`

      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
            taskId: 'tc-task-routine',
            timestamp: Date.now(),
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })

    test('legacy path-based permanently deleted disabled routine (no taskId) stays hidden', async () => {
      const today = '2025-09-24'
      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
          taskId: null,
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
            timestamp: Date.now(),
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })

    test('legacy path-based permanently deleted disabled routine without target_date stays hidden', async () => {
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const today = `${y}-${m}-${d}`

      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          taskId: null,
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
            timestamp: Date.now(),
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })

    test('legacy path deletion with missing timestamp hides the task (safe fallback)', async () => {
      const today = '2025-09-24'
      const { context, load } = createRoutineLoadContext({
        date: today,
        metadataOverrides: {
          routine_enabled: false,
          target_date: today,
          taskId: null,
        },
        deletedInstances: [
          {
            path: 'TASKS/routine.md',
            deletionType: 'permanent',
          },
        ],
      })

      await load()

      expect(context.taskInstances).toHaveLength(0)
      expect(context.tasks).toHaveLength(0)
    })
  })

  describe('active routine is unaffected', () => {
    test('active routine follows isDue schedule as before', async () => {
      const { context, load } = createRoutineLoadContext({
        date: '2025-09-24',
      })

      await load()

      expect(context.taskInstances).toHaveLength(1)
      expect(context.tasks).toHaveLength(1)
      expect(context.taskInstances[0].task.isRoutine).toBe(true)
    })
  })
})
