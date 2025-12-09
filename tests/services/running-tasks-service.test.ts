import { TFile } from 'obsidian'
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
    taskId: overrides.taskId ?? `tc-task-${(overrides.path ?? 'TASKS/routine.md').replace(/[^a-z0-9]/gi, '-')}`,
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

  it('restores routine records when deletion entry targets another duplicated instance', async () => {
    const record = createRecord({ instanceId: 'original-instance' })
    const deleted: DeletedInstance = {
      instanceId: 'duplicate-instance',
      path: record.taskPath,
      deletionType: 'temporary',
      timestamp: Date.now(),
    }

    const { result, instances } = await runRestore({
      records: [record],
      deletedInstances: [deleted],
    })

    expect(result).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].instanceId).toBe('original-instance')
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

  it('deletes running-task records by instanceId or path', async () => {
    const store: { content: string } = {
      content: JSON.stringify(
        [
          createRecord({ instanceId: 'keep-me', taskPath: 'TASKS/keep.md' }),
          createRecord({ instanceId: 'to-delete', taskPath: 'TASKS/delete-me.md' }),
        ],
        null,
        2,
      ),
    }

    const pathManager = { getLogDataPath: () => 'LOGS' }
    const dataPath = 'LOGS/running-task.json'
    const file = new TFile()
    file.path = dataPath
    Object.setPrototypeOf(file, TFile.prototype)

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === dataPath ? file : null)),
          read: jest.fn(async () => store.content),
          modify: jest.fn(async (_file: TFile, content: string) => {
            store.content = content
          }),
          adapter: {
            write: jest.fn(),
          },
        },
      },
      pathManager,
    } as unknown as TaskChutePluginLike

    const bound = new RunningTasksService(plugin)
    await bound.deleteByInstanceOrPath({ instanceId: 'to-delete', taskPath: 'TASKS/delete-me.md' })

    const updated = JSON.parse(store.content) as RunningTaskRecord[]
    expect(updated).toHaveLength(1)
    expect(updated[0]?.instanceId).toBe('keep-me')
  })

  it('only removes targeted running record when multiple instances share taskPath/taskId', async () => {
    const store: { content: string } = {
      content: JSON.stringify(
        [
          createRecord({ instanceId: 'keep-1', taskPath: 'TASKS/shared.md', taskId: 'tc-task-shared' }),
          createRecord({ instanceId: 'delete-me', taskPath: 'TASKS/shared.md', taskId: 'tc-task-shared' }),
        ],
        null,
        2,
      ),
    }

    const pathManager = { getLogDataPath: () => 'LOGS' }
    const dataPath = 'LOGS/running-task.json'
    const file = new TFile()
    file.path = dataPath
    Object.setPrototypeOf(file, TFile.prototype)

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === dataPath ? file : null)),
          read: jest.fn(async () => store.content),
          modify: jest.fn(async (_file: TFile, content: string) => {
            store.content = content
          }),
          adapter: {
            write: jest.fn(),
          },
        },
      },
      pathManager,
    } as unknown as TaskChutePluginLike

    const bound = new RunningTasksService(plugin)
    await bound.deleteByInstanceOrPath({ instanceId: 'delete-me', taskPath: 'TASKS/shared.md', taskId: 'tc-task-shared' })

    const updated = JSON.parse(store.content) as RunningTaskRecord[]
    expect(updated).toHaveLength(1)
    expect(updated[0]?.instanceId).toBe('keep-1')
  })
})

describe('RunningTasksService.renameTaskPath', () => {
  const createServiceWithStore = () => {
    const store = new Map<string, string>()
    const pathManager = {
      getLogDataPath: () => 'LOGS',
    }

    const createFile = (path: string) => {
      const file = new TFile()
      file.path = path
      Object.setPrototypeOf(file, TFile.prototype)
      return file
    }

    const vault = {
      getAbstractFileByPath: jest.fn((path: string) =>
        store.has(path) ? createFile(path) : null,
      ),
      read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
      modify: jest.fn(async (file: TFile, content: string) => {
        store.set(file.path, content)
      }),
      adapter: {
        write: jest.fn(async (path: string, content: string) => {
          store.set(path, content)
        }),
      },
    }

    const plugin = {
      app: { vault },
      pathManager,
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    const dataPath = 'LOGS/running-task.json'
    store.set(
      dataPath,
      JSON.stringify(
        [
          {
            date: '2025-10-16',
            taskTitle: 'Old Title',
            taskPath: 'TASKS/old.md',
            startTime: new Date('2025-10-16T09:00:00.000Z').toISOString(),
          },
        ],
        null,
        2,
      ),
    )

    return { service, store, vault, dataPath }
  }

  it('renames taskPath and updates title when provided', async () => {
    const { service, store, dataPath, vault } = createServiceWithStore()

    await service.renameTaskPath('TASKS/old.md', 'TASKS/new.md', { newTitle: 'New Title' })

    expect(vault.modify).toHaveBeenCalled()
    const updated = JSON.parse(store.get(dataPath) ?? '[]') as RunningTaskRecord[]
    expect(updated[0]).toEqual(
      expect.objectContaining({ taskPath: 'TASKS/new.md', taskTitle: 'New Title' }),
    )
  })

  it('skips rewrite when no matching record exists', async () => {
    const { service, store, dataPath, vault } = createServiceWithStore()

    await service.renameTaskPath('TASKS/missing.md', 'TASKS/new.md')

    expect(vault.modify).not.toHaveBeenCalled()
    const unchanged = JSON.parse(store.get(dataPath) ?? '[]') as RunningTaskRecord[]
    expect(unchanged[0]).toEqual(
      expect.objectContaining({ taskPath: 'TASKS/old.md', taskTitle: 'Old Title' }),
    )
  })
})
