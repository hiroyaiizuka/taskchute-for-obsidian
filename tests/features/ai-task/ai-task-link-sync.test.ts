import { AiTaskLinkSync, type AiTaskLinkSyncHost } from '@/features/ai-task/services/AiTaskLinkSync'
import type { TaskInstance } from '@/types'

function human(title: string, instanceId = `human-${title}`): TaskInstance {
  return {
    task: { file: null, frontmatter: {}, path: `TASKS/${title}.md`, name: title, displayTitle: title },
    instanceId,
    state: 'idle',
    slotKey: 'none',
  }
}

function linkedAi(
  taskTitle: string,
  instanceId = 'ai-1',
  overrides: Record<string, unknown> = {},
): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: {
        ai_task: true,
        isRoutine: true,
        routine_enabled: true,
        obsidian_sync: { enabled: true, taskTitle, matchType: 'exact' },
        ...overrides,
      },
      path: 'TASKS/linked-ai.md',
      name: 'linked-ai',
      displayTitle: 'Linked AI',
      isRoutine: true,
    },
    instanceId,
    state: 'idle',
    slotKey: 'none',
  }
}

function createHost(instances: TaskInstance[]): jest.Mocked<AiTaskLinkSyncHost> {
  return {
    getTaskInstances: jest.fn(() => instances),
    startInstance: jest.fn(async (inst: TaskInstance) => {
      inst.state = 'running'
    }),
    stopInstance: jest.fn(async (inst: TaskInstance) => {
      inst.state = 'done'
    }),
    resetToIdle: jest.fn(async (inst: TaskInstance) => {
      inst.state = 'idle'
    }),
    deleteInstance: jest.fn<Promise<void>, [TaskInstance]>().mockResolvedValue(undefined),
    moveToDate: jest.fn<Promise<boolean>, [TaskInstance, string]>().mockResolvedValue(true),
  }
}

describe('AiTaskLinkSync.partnerOf', () => {
  test('finds the AI routine of a human task and the human task of an AI routine', () => {
    const source = human('CEO review')
    const target = linkedAi('CEO review')
    const sync = new AiTaskLinkSync(createHost([source, target]))

    expect(sync.partnerOf(source)).toBe(target)
    expect(sync.partnerOf(target)).toBe(source)
  })

  test('has no partner when the titles do not match or the routine is disabled', () => {
    const other = human('Other task')
    const disabled = linkedAi('CEO review', 'ai-off', { routine_enabled: false })
    const source = human('CEO review')
    const sync = new AiTaskLinkSync(createHost([other, disabled, source]))

    expect(sync.partnerOf(other)).toBeUndefined()
    expect(sync.partnerOf(source)).toBeUndefined()
  })

  test('prefers the duplicate in the requested state', () => {
    const source = human('CEO review')
    const doneTarget = linkedAi('CEO review', 'ai-done')
    doneTarget.state = 'done'
    const runningTarget = linkedAi('CEO review', 'ai-running')
    runningTarget.state = 'running'
    const sync = new AiTaskLinkSync(createHost([source, doneTarget, runningTarget]))

    expect(sync.partnerOf(source, 'running')).toBe(runningTarget)
    expect(sync.partnerOf(source, 'done')).toBe(doneTarget)
  })
})

describe('AiTaskLinkSync keeps the pair in step', () => {
  test('starting the AI side starts its human task; starting the human side is left to the coordinator', async () => {
    const source = human('CEO review')
    const target = linkedAi('CEO review')
    target.state = 'running'
    const host = createHost([source, target])
    const sync = new AiTaskLinkSync(host)

    await sync.afterStarted(target)
    expect(host.startInstance).toHaveBeenCalledWith(source)
    expect(source.state).toBe('running')

    host.startInstance.mockClear()
    await sync.afterStarted(source)
    expect(host.startInstance).not.toHaveBeenCalled()
  })

  test('stopping either side stops the other, without echoing back', async () => {
    const source = human('CEO review')
    source.state = 'running'
    const target = linkedAi('CEO review')
    target.state = 'running'
    const host = createHost([source, target])
    const sync = new AiTaskLinkSync(host)
    // The real host's stop raises afterStopped for the partner as well.
    host.stopInstance.mockImplementation(async (inst) => {
      inst.state = 'done'
      await sync.afterStopped(inst)
    })

    target.state = 'done'
    await sync.afterStopped(target)

    expect(host.stopInstance).toHaveBeenCalledTimes(1)
    expect(host.stopInstance).toHaveBeenCalledWith(source)
    expect(source.state).toBe('done')
  })

  test('resetting either side from done resets the other', async () => {
    const source = human('CEO review')
    source.state = 'done'
    const target = linkedAi('CEO review')
    target.state = 'idle'
    const host = createHost([source, target])
    const sync = new AiTaskLinkSync(host)

    await sync.afterResetToIdle(target, 'done')

    expect(host.resetToIdle).toHaveBeenCalledWith(source)
    expect(source.state).toBe('idle')
  })

  test('deleting one side deletes the partner found before the deletion', async () => {
    const source = human('CEO review')
    const target = linkedAi('CEO review')
    const host = createHost([source, target])
    const sync = new AiTaskLinkSync(host)

    await sync.afterDeleted(source, target)

    expect(host.deleteInstance).toHaveBeenCalledWith(target)
  })

  test('moving one side moves the partner to the same date', async () => {
    const source = human('CEO review')
    source.state = 'running'
    const target = linkedAi('CEO review')
    target.state = 'running'
    const host = createHost([source, target])
    const sync = new AiTaskLinkSync(host)
    host.moveToDate.mockImplementation(async (inst, dateStr) => {
      await sync.afterMoved(inst, dateStr)
      return true
    })

    const movedAlong = await sync.afterMoved(target, '2026-10-03')

    expect(movedAlong).toBe(1)
    expect(host.moveToDate).toHaveBeenCalledTimes(1)
    expect(host.moveToDate).toHaveBeenCalledWith(source, '2026-10-03')
  })

  test('an unlinked task changes nothing else', async () => {
    const lonely = human('Lonely')
    lonely.state = 'done'
    const host = createHost([lonely, linkedAi('CEO review')])
    const sync = new AiTaskLinkSync(host)

    await sync.afterStopped(lonely)
    await sync.afterResetToIdle(lonely, 'done')
    await sync.afterMoved(lonely, '2026-10-03')

    expect(host.stopInstance).not.toHaveBeenCalled()
    expect(host.resetToIdle).not.toHaveBeenCalled()
    expect(host.moveToDate).not.toHaveBeenCalled()
  })
})
