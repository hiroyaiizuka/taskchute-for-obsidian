import { RunningTasksService, type RunningTaskRecord } from '../../src/features/core/services/RunningTasksService'
import type {
  DeletedInstance,
  HiddenRoutine,
  TaskChutePluginLike,
  TaskData,
  TaskInstance,
} from '../../src/types'

describe('RunningTasksService.restoreForDate', () => {
  const dateString = '2025-10-13'

  const createService = (): RunningTasksService => {
    return new RunningTasksService({} as TaskChutePluginLike)
  }

  const createTaskData = (overrides: Partial<TaskData> = {}): TaskData => ({
    file: null,
    frontmatter: {},
    path: overrides.path ?? 'TASKS/routine.md',
    name: overrides.name ?? 'Routine Task',
    isRoutine: overrides.isRoutine ?? true,
  })

  const createRecord = (overrides: Partial<RunningTaskRecord> = {}): RunningTaskRecord => ({
    date: overrides.date ?? dateString,
    taskTitle: overrides.taskTitle ?? 'Routine Task',
    taskPath: overrides.taskPath ?? 'TASKS/routine.md',
    startTime: overrides.startTime ?? new Date('2025-10-13T09:00:00.000Z').toISOString(),
    slotKey: overrides.slotKey,
    originalSlotKey: overrides.originalSlotKey,
    instanceId: overrides.instanceId ?? 'routine-instance',
    taskDescription: overrides.taskDescription,
    isRoutine: overrides.isRoutine ?? true,
  })

  const runRestore = async (options: {
    records: RunningTaskRecord[]
    instances?: TaskInstance[]
    deletedPaths?: string[]
    hiddenRoutines?: Array<HiddenRoutine | string>
    deletedInstances?: DeletedInstance[]
    taskData?: TaskData
  }): Promise<{ result: TaskInstance[]; instances: TaskInstance[] }> => {
    const service = createService()
    jest.spyOn(service, 'loadForDate').mockResolvedValue(options.records)

    const instances: TaskInstance[] = options.instances ?? []
    const task = options.taskData ?? createTaskData()

    const restored = await service.restoreForDate({
      dateString,
      instances,
      deletedPaths: options.deletedPaths ?? [],
      hiddenRoutines: options.hiddenRoutines ?? [],
      deletedInstances: options.deletedInstances ?? [],
      findTaskByPath: (path) => (path === task.path ? task : undefined),
      generateInstanceId: () => 'generated-instance',
    })

    return { result: restored, instances }
  }

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('skips records hidden via day state entries', async () => {
    const record = createRecord()
    const hidden: HiddenRoutine = { path: record.taskPath, instanceId: null }

    const { result, instances } = await runRestore({
      records: [record],
      hiddenRoutines: [hidden],
    })

    expect(result).toHaveLength(0)
    expect(instances).toHaveLength(0)
  })

  it('skips records flagged as deleted by instanceId', async () => {
    const record = createRecord({ instanceId: 'to-delete' })
    const deleted: DeletedInstance = {
      instanceId: 'to-delete',
      path: record.taskPath,
      deletionType: 'temporary',
      timestamp: Date.now(),
    }

    const { result, instances } = await runRestore({
      records: [record],
      deletedInstances: [deleted],
    })

    expect(result).toHaveLength(0)
    expect(instances).toHaveLength(0)
  })

  it('restores records when not hidden or deleted', async () => {
    const record = createRecord({ slotKey: '0900' })

    const { result, instances } = await runRestore({
      records: [record],
    })

    expect(result).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].state).toBe('running')
    expect(instances[0].task.path).toBe(record.taskPath)
  })

  it('still restores non-routine records when temporary deletion belongs to another path', async () => {
    const record = createRecord({
      taskPath: 'TASKS/non-routine.md',
      isRoutine: false,
      instanceId: 'non-routine-instance',
    })

    const { result } = await runRestore({
      records: [record],
      deletedInstances: [
        {
          instanceId: 'unrelated',
          path: 'TASKS/other.md',
          deletionType: 'temporary',
          timestamp: Date.now(),
        },
      ],
      taskData: createTaskData({
        path: 'TASKS/non-routine.md',
        isRoutine: false,
        name: 'Non Routine Task',
      }),
    })

    expect(result).toHaveLength(1)
  })
})
