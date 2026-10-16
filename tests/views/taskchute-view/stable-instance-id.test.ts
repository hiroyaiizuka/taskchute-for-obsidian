import { baseInstanceId } from '@/features/core/services/TaskLoaderService'
import { createNonRoutineLoadContext, createRoutineLoadContext } from '@tests/utils/taskViewTestUtils'

// A task's own instance for the day gets the same id on every load, so what
// is keyed by it (comments, a temporary deletion, a hidden instance) still
// finds it after the view reloads.

describe("a day's own task instance has a stable id", () => {
  test('a routine gets the same id on every load', async () => {
    const { context, load, routinePath } = createRoutineLoadContext()
    await load()
    const first = context.taskInstances.map((inst) => inst.instanceId)
    await load()
    const second = context.taskInstances.map((inst) => inst.instanceId)
    expect(first).toEqual([baseInstanceId(routinePath, '2025-09-24')])
    expect(second).toEqual(first)
  })

  test('a non-routine task gets the same id on every load', async () => {
    const { context, load } = createNonRoutineLoadContext()
    await load()
    const first = context.taskInstances.map((inst) => inst.instanceId)
    await load()
    expect(first).toEqual([baseInstanceId('TASKS/non-routine.md', '2025-09-24')])
    expect(context.taskInstances.map((inst) => inst.instanceId)).toEqual(first)
  })

  test("the id is the day's: another date gives another id", () => {
    expect(baseInstanceId('TASKS/a.md', '2025-09-24')).not.toBe(baseInstanceId('TASKS/a.md', '2025-09-25'))
  })

  test('keeps the path_date_ shape that older readers parse', () => {
    expect(baseInstanceId('TASKS/a.md', '2025-09-24')).toMatch(/^TASKS\/a\.md_2025-09-24_/)
  })

  test("a temporary deletion of a routine's own instance still hides it after a reload", async () => {
    const { context, load, routinePath } = createRoutineLoadContext({
      deletedInstances: [
        {
          instanceId: baseInstanceId('TASKS/routine.md', '2025-09-24'),
          path: 'TASKS/routine.md',
          deletionType: 'temporary',
          timestamp: 1,
          deletedAt: 1,
        },
      ],
    })
    await load()
    expect(context.taskInstances.filter((inst) => inst.task.path === routinePath)).toHaveLength(0)
  })

  test('a temporary deletion recorded with an old random id (older data) matches nothing, as before', async () => {
    const { context, load, routinePath } = createRoutineLoadContext({
      deletedInstances: [
        {
          instanceId: 'TASKS/routine.md_2025-09-24_1727130000000_abc123xyz',
          path: 'TASKS/routine.md',
          deletionType: 'temporary',
          timestamp: 1,
          deletedAt: 1,
        },
      ],
    })
    await load()
    expect(context.taskInstances.filter((inst) => inst.task.path === routinePath)).toHaveLength(1)
  })

  test('an instance hidden by its id stays hidden after a reload', async () => {
    const { context, load, routinePath } = createRoutineLoadContext({
      hiddenRoutines: [{ path: 'TASKS/routine.md', instanceId: baseInstanceId('TASKS/routine.md', '2025-09-24') }],
    })
    await load()
    expect(context.taskInstances.filter((inst) => inst.task.path === routinePath)).toHaveLength(0)
  })
})
