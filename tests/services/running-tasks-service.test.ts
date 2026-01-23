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

  it('restores records when hidden entry targets another instance', async () => {
    const record = createRecord({ instanceId: 'running-instance' })
    const hidden: HiddenRoutine = {
      path: record.taskPath,
      instanceId: 'other-instance',
    }

    const { result, instances } = await runRestore({
      records: [record],
      hiddenRoutines: [hidden],
    })

    expect(result).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].instanceId).toBe('running-instance')
    expect(instances[0].state).toBe('running')
  })

  it('restores records when path-level hidden exists but instance is visible', async () => {
    const record = createRecord({ instanceId: 'visible-instance' })
    const task = createTaskData({ path: record.taskPath, isRoutine: true })
    const existing: TaskInstance = {
      task,
      instanceId: 'visible-instance',
      state: 'idle',
      slotKey: 'none',
      date: dateString,
      createdMillis: Date.now(),
    }
    const hidden: HiddenRoutine = { path: record.taskPath, instanceId: null }

    const { result, instances } = await runRestore({
      records: [record],
      instances: [existing],
      hiddenRoutines: [hidden],
      taskData: task,
    })

    expect(result).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].instanceId).toBe('visible-instance')
    expect(instances[0].state).toBe('running')
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

  it('restores records by resolving task data from vault when missing in list', async () => {
    const file = new TFile()
    const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {}
    if (Object.getPrototypeOf(file) !== proto) {
      Object.setPrototypeOf(file, proto)
    }
    if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
      ;(file as { constructor?: unknown }).constructor = TFile
    }
    file.path = 'TASKS/weekly.md'
    file.basename = 'weekly'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === file.path ? file : null)),
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({
            frontmatter: {
              title: 'Weekly Journal',
              isRoutine: true,
              taskId: 'tc-weekly',
            },
          })),
        },
      },
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    jest.spyOn(service, 'loadForDate').mockResolvedValue([
      createRecord({
        taskPath: 'TASKS/weekly.md',
        taskTitle: 'Weekly Journal',
        instanceId: 'weekly-instance',
      }),
    ])

    const instances: TaskInstance[] = []
    const restored = await service.restoreForDate({
      dateString,
      instances,
      deletedPaths: [],
      hiddenRoutines: [],
      deletedInstances: [],
      findTaskByPath: () => undefined,
      generateInstanceId: () => 'generated-instance',
    })

    expect(restored).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].task.path).toBe('TASKS/weekly.md')
    expect(instances[0].task.displayTitle).toBe('Weekly Journal')
    expect(instances[0].task.isRoutine).toBe(true)
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

  it('does not rewrite instanceId when renaming task path', async () => {
    const store = new Map<string, string>()
    const pathManager = { getLogDataPath: () => 'LOGS' }

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
            taskTitle: 'Running Task',
            taskPath: 'TASKS/old.md',
            startTime: new Date('2025-10-16T09:00:00.000Z').toISOString(),
            instanceId: 'TASKS/old.md_2025-10-16_1234567890_abc123',
          },
        ],
        null,
        2,
      ),
    )

    await service.renameTaskPath('TASKS/old.md', 'TASKS/new.md', { newTitle: 'New Task' })

    expect(vault.modify).toHaveBeenCalled()
    const updated = JSON.parse(store.get(dataPath) ?? '[]') as RunningTaskRecord[]
    expect(updated[0]).toEqual(
      expect.objectContaining({
        taskPath: 'TASKS/new.md',
        taskTitle: 'New Task',
        instanceId: 'TASKS/old.md_2025-10-16_1234567890_abc123',
      }),
    )
  })
})

describe('RunningTasksService.restoreForDate - taskId fallback', () => {
  const dateString = '2025-10-13'

  const createTaskData = (overrides: Partial<TaskData> = {}): TaskData => ({
    file: null,
    frontmatter: {},
    path: overrides.path ?? 'TASKS/routine.md',
    name: overrides.name ?? 'Routine Task',
    isRoutine: overrides.isRoutine ?? true,
    taskId: overrides.taskId ?? 'tc-task-123',
  })

  const createRecord = (overrides: Partial<RunningTaskRecord> = {}): RunningTaskRecord => ({
    date: overrides.date ?? dateString,
    taskTitle: overrides.taskTitle ?? 'Routine Task',
    taskPath: overrides.taskPath ?? 'TASKS/routine.md',
    startTime: overrides.startTime ?? new Date('2025-10-13T09:00:00.000Z').toISOString(),
    slotKey: overrides.slotKey,
    originalSlotKey: overrides.originalSlotKey,
    instanceId: overrides.instanceId ?? 'old-instance-id',
    taskDescription: overrides.taskDescription,
    isRoutine: overrides.isRoutine ?? true,
    taskId: overrides.taskId ?? 'tc-task-123',
  })

  it('prefers path match over taskId match when both exist', async () => {
    const plugin = {} as TaskChutePluginLike
    const service = new RunningTasksService(plugin)

    const record = createRecord({
      taskPath: 'TASKS/path-match.md',
      taskId: 'tc-task-shared',
      instanceId: 'record-instance',
    })

    jest.spyOn(service, 'loadForDate').mockResolvedValue([record])

    const taskIdMatch = createTaskData({
      path: 'TASKS/other.md',
      taskId: 'tc-task-shared',
    })
    const taskPathMatch = createTaskData({
      path: 'TASKS/path-match.md',
      taskId: 'tc-task-different',
    })

    const instanceTaskId: TaskInstance = {
      task: taskIdMatch,
      instanceId: 'taskid-instance',
      state: 'idle',
      slotKey: 'none',
      date: dateString,
      createdMillis: Date.now(),
    }
    const instancePath: TaskInstance = {
      task: taskPathMatch,
      instanceId: 'path-instance',
      state: 'idle',
      slotKey: 'none',
      date: dateString,
      createdMillis: Date.now(),
    }

    const instances: TaskInstance[] = [instanceTaskId, instancePath]

    const restored = await service.restoreForDate({
      dateString,
      instances,
      deletedPaths: [],
      hiddenRoutines: [],
      deletedInstances: [],
      findTaskByPath: () => undefined,
      generateInstanceId: () => 'generated-instance',
    })

    expect(restored).toHaveLength(1)
    expect(instancePath.state).toBe('running')
    expect(instanceTaskId.state).toBe('idle')
    expect(instancePath.task.path).toBe('TASKS/path-match.md')
  })

  it('restores running state via taskId when instanceId changes after file rename', async () => {
    const plugin = {} as TaskChutePluginLike
    const service = new RunningTasksService(plugin)

    // Simulate: record has old instanceId and old path, but same taskId
    const record = createRecord({
      taskPath: 'TASKS/old-name.md',
      instanceId: 'TASKS/old-name.md_2025-10-13_1234567890_abc',
      taskId: 'tc-task-stable-id',
    })

    jest.spyOn(service, 'loadForDate').mockResolvedValue([record])

    // Task instance now has new path and new instanceId, but same taskId
    const task = createTaskData({
      path: 'TASKS/new-name.md',
      taskId: 'tc-task-stable-id',
    })
    const instance: TaskInstance = {
      task,
      instanceId: 'TASKS/new-name.md_2025-10-13_9999999999_xyz', // Different instanceId
      state: 'idle',
      slotKey: 'none',
      date: dateString,
      createdMillis: Date.now(),
    }

    const instances: TaskInstance[] = [instance]

    const restored = await service.restoreForDate({
      dateString,
      instances,
      deletedPaths: [],
      hiddenRoutines: [],
      deletedInstances: [],
      findTaskByPath: () => undefined, // path doesn't match
      generateInstanceId: () => 'generated-instance',
    })

    expect(restored).toHaveLength(1)
    expect(instances[0].state).toBe('running')
    expect(instances[0].startTime).toBeDefined()
    // Instance should be restored via taskId match
    expect(instances[0].task.taskId).toBe('tc-task-stable-id')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })
})
