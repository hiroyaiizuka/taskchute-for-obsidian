import { TFile } from 'obsidian'
import { RunningTasksService, type RunningTaskRecord } from '../../src/features/core/services/RunningTasksService'
import { SectionConfigService } from '../../src/services/SectionConfigService'
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

  it('skips records when legacy permanent deletion lacks timestamp', async () => {
    const record = createRecord()
    const deleted: DeletedInstance = {
      path: record.taskPath,
      deletionType: 'permanent',
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

  it('persists migrated slot keys to running-task.json using startTime re-calculation', async () => {
    // startTime is 2025-10-13T09:00:00.000Z (UTC) → local time depends on timezone
    // With boundaries [0,6,12,18], slot is determined by local hour from startTime
    const record = createRecord({
      taskPath: 'TASKS/migrate-target.md',
      slotKey: '8:00-12:00',
      originalSlotKey: '16:00-0:00',
      instanceId: 'migrate-instance',
      startTime: new Date('2025-10-13T09:00:00.000Z').toISOString(),
    })
    const dataPath = 'LOGS/running-task.json'
    const store = new Map<string, string>([
      [dataPath, JSON.stringify([record], null, 2)],
    ])

    const createFile = (path: string) => {
      const file = new TFile()
      file.path = path
      Object.setPrototypeOf(file, TFile.prototype)
      return file
    }

    const plugin = {
      pathManager: { getLogDataPath: () => 'LOGS' },
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (store.has(path) ? createFile(path) : null)),
          read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
          adapter: {
            exists: jest.fn(async (path: string) => store.has(path)),
            read: jest.fn(async (path: string) => store.get(path) ?? ''),
            write: jest.fn(async (path: string, content: string) => {
              store.set(path, content)
            }),
          },
        },
      },
    } as unknown as TaskChutePluginLike

    const sectionConfig = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 18, minute: 0 },
    ])
    const service = new RunningTasksService(plugin)
    service.setSectionConfig(sectionConfig)

    const task = createTaskData({ path: record.taskPath })
    const instances: TaskInstance[] = []

    const restored = await service.restoreForDate({
      dateString,
      instances,
      deletedPaths: [],
      hiddenRoutines: [],
      deletedInstances: [],
      findTaskByPath: (path) => (path === task.path ? task : undefined),
      generateInstanceId: () => 'generated-instance',
    })

    expect(restored).toHaveLength(1)
    // Slot is re-calculated from startTime via getCurrentTimeSlot(new Date(startTime))
    const startDate = new Date(record.startTime)
    const expectedSlot = sectionConfig.getCurrentTimeSlot(startDate)
    expect(restored[0]?.slotKey).toBe(expectedSlot)
    expect(plugin.app.vault.adapter.write).toHaveBeenCalled()

    const persisted = JSON.parse(store.get(dataPath) ?? '[]') as RunningTaskRecord[]
    expect(persisted[0]?.slotKey).toBe(expectedSlot)
    // originalSlotKey is cleared (undefined) when invalid
    expect(persisted[0]?.originalSlotKey).toBeUndefined()
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

  it('resolves reminder_time from frontmatter with string value "09:55"', async () => {
    const file = new TFile()
    Object.setPrototypeOf(file, TFile.prototype)
    file.path = 'TASKS/with-reminder.md'
    file.basename = 'with-reminder'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === file.path ? file : null)),
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({
            frontmatter: {
              title: 'Reminder Task',
              isRoutine: false,
              taskId: 'tc-reminder',
              reminder_time: '09:55',
            },
          })),
        },
      },
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    jest.spyOn(service, 'loadForDate').mockResolvedValue([
      createRecord({
        taskPath: 'TASKS/with-reminder.md',
        taskTitle: 'Reminder Task',
        instanceId: 'reminder-instance',
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
    expect(instances[0].task.reminder_time).toBe('09:55')
  })

  it('normalizes numeric reminder_time (615) from frontmatter to "10:15"', async () => {
    const file = new TFile()
    Object.setPrototypeOf(file, TFile.prototype)
    file.path = 'TASKS/numeric-reminder.md'
    file.basename = 'numeric-reminder'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === file.path ? file : null)),
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({
            frontmatter: {
              title: 'Numeric Reminder Task',
              isRoutine: true,
              taskId: 'tc-numeric-reminder',
              reminder_time: 615,
            },
          })),
        },
      },
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    jest.spyOn(service, 'loadForDate').mockResolvedValue([
      createRecord({
        taskPath: 'TASKS/numeric-reminder.md',
        taskTitle: 'Numeric Reminder Task',
        instanceId: 'numeric-reminder-instance',
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
    expect(instances[0].task.reminder_time).toBe('10:15')
  })

  it('restores reminder_time from vault frontmatter via resolveTaskDataFromPath', async () => {
    const file = new TFile()
    const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {}
    if (Object.getPrototypeOf(file) !== proto) {
      Object.setPrototypeOf(file, proto)
    }
    if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
      ;(file as { constructor?: unknown }).constructor = TFile
    }
    file.path = 'TASKS/reminder-task.md'
    file.basename = 'reminder-task'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === file.path ? file : null)),
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({
            frontmatter: {
              title: 'Reminder Task',
              isRoutine: true,
              taskId: 'tc-reminder',
              reminder_time: '09:55',
            },
          })),
        },
      },
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    jest.spyOn(service, 'loadForDate').mockResolvedValue([
      createRecord({
        taskPath: 'TASKS/reminder-task.md',
        taskTitle: 'Reminder Task',
        instanceId: 'reminder-instance',
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
    expect(instances[0].task.reminder_time).toBe('09:55')
  })

  it('normalizes numeric reminder_time (615) from vault frontmatter to "10:15"', async () => {
    const file = new TFile()
    const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {}
    if (Object.getPrototypeOf(file) !== proto) {
      Object.setPrototypeOf(file, proto)
    }
    if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
      ;(file as { constructor?: unknown }).constructor = TFile
    }
    file.path = 'TASKS/numeric-reminder.md'
    file.basename = 'numeric-reminder'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === file.path ? file : null)),
        },
        metadataCache: {
          getFileCache: jest.fn(() => ({
            frontmatter: {
              title: 'Numeric Reminder',
              isRoutine: false,
              taskId: 'tc-numeric',
              reminder_time: 615,
            },
          })),
        },
      },
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    jest.spyOn(service, 'loadForDate').mockResolvedValue([
      createRecord({
        taskPath: 'TASKS/numeric-reminder.md',
        taskTitle: 'Numeric Reminder',
        instanceId: 'numeric-instance',
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
    expect(instances[0].task.reminder_time).toBe('10:15')
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
            exists: jest.fn(async (path: string) => path === dataPath),
            read: jest.fn(async () => store.content),
            write: jest.fn(async (_path: string, content: string) => {
              store.content = content
            }),
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
            exists: jest.fn(async (path: string) => path === dataPath),
            read: jest.fn(async () => store.content),
            write: jest.fn(async (_path: string, content: string) => {
              store.content = content
            }),
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

  it('serializes strict recovery deletions across service instances', async () => {
    let content = JSON.stringify([
      createRecord({ instanceId: 'delete-a', taskPath: 'TASKS/a.md' }),
      createRecord({ instanceId: 'delete-b', taskPath: 'TASKS/b.md' }),
      createRecord({ instanceId: 'keep', taskPath: 'TASKS/keep.md' }),
    ])
    const adapter = {
      exists: jest.fn(async () => true),
      read: jest.fn(async () => content),
      write: jest.fn(async (_path: string, next: string) => {
        content = next
      }),
    }
    const plugin = {
      app: { vault: { adapter } },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike

    await Promise.all([
      new RunningTasksService(plugin).deleteByInstanceOrPathStrict({
        instanceId: 'delete-a',
      }),
      new RunningTasksService(plugin).deleteByInstanceOrPathStrict({
        instanceId: 'delete-b',
      }),
    ])

    const remaining = JSON.parse(content) as RunningTaskRecord[]
    expect(remaining.map((record) => record.instanceId)).toEqual(['keep'])
    expect(adapter.write).toHaveBeenCalledTimes(2)
  })

  it('finds an off-screen running timer by instanceId across board dates', async () => {
    const previousDay = createRecord({
      date: '2026-07-18',
      instanceId: 'previous-day',
      taskPath: 'TASKS/ai-memory.md',
    })
    const today = createRecord({
      date: '2026-07-19',
      instanceId: 'today',
      taskPath: 'TASKS/today.md',
    })
    const plugin = {
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => true),
            read: jest.fn(async () => JSON.stringify([previousDay, today])),
          },
        },
      },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike

    await expect(
      new RunningTasksService(plugin).findByInstanceOrPathStrict({
        instanceId: 'previous-day',
        taskPath: 'TASKS/ai-memory.md',
      }),
    ).resolves.toEqual(previousDay)
  })

  it('does not use a path fallback when duplicated running records are ambiguous', async () => {
    const records = [
      createRecord({
        instanceId: 'duplicate-a',
        taskPath: 'TASKS/shared.md',
      }),
      createRecord({
        instanceId: 'duplicate-b',
        taskPath: 'TASKS/shared.md',
      }),
    ]
    const plugin = {
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => true),
            read: jest.fn(async () => JSON.stringify(records)),
          },
        },
      },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike

    await expect(
      new RunningTasksService(plugin).findByInstanceOrPathStrict({
        instanceId: 'stale-instance',
        taskPath: 'TASKS/shared.md',
      }),
    ).resolves.toBeUndefined()
  })

  it('runs orphan cleanup only when the durable running record still exists', async () => {
    let content = JSON.stringify([
      createRecord({
        instanceId: 'running-instance',
        taskPath: 'TASKS/ai-memory.md',
      }),
    ])
    const order: string[] = []
    const adapter = {
      exists: jest.fn(async () => true),
      read: jest.fn(async () => content),
      write: jest.fn(async (_path: string, next: string) => {
        order.push('write')
        content = next
      }),
    }
    const plugin = {
      app: { vault: { adapter } },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike
    const service = new RunningTasksService(plugin)
    const cleanup = jest.fn(async () => {
      order.push('cleanup')
    })

    await expect(
      service.deleteByInstanceOrPathStrict(
        { instanceId: 'running-instance' },
        cleanup,
      ),
    ).resolves.toBe(1)
    expect(order).toEqual(['cleanup', 'write'])

    await expect(
      service.deleteByInstanceOrPathStrict(
        { instanceId: 'running-instance' },
        cleanup,
      ),
    ).resolves.toBe(0)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['cleanup', 'write'])
  })

  it('lets strict recovery deletion failures reject for caller rollback', async () => {
    const plugin = {
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => true),
            read: jest.fn(async () => JSON.stringify([createRecord()])),
            write: jest.fn(async () => {
              throw new Error('disk full')
            }),
          },
        },
      },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike

    await expect(
      new RunningTasksService(plugin).deleteByInstanceOrPathStrict({
        instanceId: 'routine-instance',
      }),
    ).rejects.toThrow('disk full')
  })

  it('serializes rename with strict deletion so a stale rename cannot restore a deleted record', async () => {
    let content = JSON.stringify([
      createRecord({
        instanceId: 'delete-me',
        taskPath: 'TASKS/old.md',
        taskTitle: 'Old title',
      }),
      createRecord({
        instanceId: 'keep',
        taskPath: 'TASKS/keep.md',
        taskTitle: 'Keep',
      }),
    ])
    let readCount = 0
    let releaseFirstRead!: () => void
    const firstReadReleased = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    let signalFirstRead!: () => void
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstRead = resolve
    })
    const adapter = {
      exists: jest.fn(async () => true),
      read: jest.fn(async () => {
        readCount += 1
        const snapshot = content
        if (readCount === 1) {
          signalFirstRead()
          await firstReadReleased
        }
        return snapshot
      }),
      write: jest.fn(async (_path: string, next: string) => {
        content = next
      }),
    }
    const plugin = {
      app: { vault: { adapter } },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike
    const renameService = new RunningTasksService(plugin)
    const deleteService = new RunningTasksService(plugin)

    const renamePromise = renameService.renameTaskPath(
      'TASKS/old.md',
      'TASKS/renamed.md',
      { newTitle: 'Renamed' },
    )
    await firstReadStarted
    const deletePromise = deleteService.deleteByInstanceOrPathStrict({
      instanceId: 'delete-me',
    })
    await Promise.resolve()
    await Promise.resolve()

    // The delete cannot read the stale pre-rename snapshot while rename owns
    // the shared adapter/path mutation boundary.
    expect(readCount).toBe(1)

    releaseFirstRead()
    await Promise.all([renamePromise, deletePromise])

    const remaining = JSON.parse(content) as RunningTaskRecord[]
    expect(remaining.map((record) => record.instanceId)).toEqual(['keep'])
  })

  it('does not resurrect a deleted record from a stale slot-migration snapshot', async () => {
    const staleRecord = createRecord({
      instanceId: 'delete-me',
      taskPath: 'TASKS/migrate-then-delete.md',
      slotKey: '8:00-12:00',
    })
    let content = JSON.stringify([staleRecord])
    const dataPath = 'LOGS/running-task.json'
    const file = new TFile()
    file.path = dataPath
    Object.setPrototypeOf(file, TFile.prototype)

    let releaseDeleteWrite!: () => void
    const deleteWriteReleased = new Promise<void>((resolve) => {
      releaseDeleteWrite = resolve
    })
    let signalDeleteWrite!: () => void
    const deleteWriteStarted = new Promise<void>((resolve) => {
      signalDeleteWrite = resolve
    })
    let adapterReadCount = 0
    const adapter = {
      exists: jest.fn(async () => true),
      read: jest.fn(async () => {
        adapterReadCount += 1
        return content
      }),
      write: jest.fn(async (_path: string, next: string) => {
        if (adapter.write.mock.calls.length === 1) {
          signalDeleteWrite()
          await deleteWriteReleased
        }
        content = next
      }),
    }
    let signalRestoreLoad!: () => void
    const restoreLoadStarted = new Promise<void>((resolve) => {
      signalRestoreLoad = resolve
    })
    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn((path: string) => (path === dataPath ? file : null)),
          read: jest.fn(async () => {
            signalRestoreLoad()
            return content
          }),
          adapter,
        },
      },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike
    const deleteService = new RunningTasksService(plugin)
    const restoreService = new RunningTasksService(plugin)
    restoreService.setSectionConfig(new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 6, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 18, minute: 0 },
    ]))

    const deletePromise = deleteService.deleteByInstanceOrPathStrict({
      instanceId: 'delete-me',
    })
    await deleteWriteStarted

    const restorePromise = restoreService.restoreForDate({
      dateString,
      instances: [],
      deletedPaths: [],
      hiddenRoutines: [],
      deletedInstances: [],
      findTaskByPath: () => createTaskData({ path: staleRecord.taskPath }),
      generateInstanceId: () => 'generated-instance',
    })
    await restoreLoadStarted
    await Promise.resolve()
    await Promise.resolve()

    // loadForDate read the old snapshot, but its migration write must wait for
    // the strict deletion and then re-read current storage under the same lock.
    expect(adapterReadCount).toBe(1)

    releaseDeleteWrite()
    await Promise.all([deletePromise, restorePromise])

    expect(JSON.parse(content)).toEqual([])
    expect(adapter.write).toHaveBeenCalledTimes(1)
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
        exists: jest.fn(async (path: string) => store.has(path)),
        read: jest.fn(async (path: string) => store.get(path) ?? ''),
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

    expect(vault.adapter.write).toHaveBeenCalled()
    const updated = JSON.parse(store.get(dataPath) ?? '[]') as RunningTaskRecord[]
    expect(updated[0]).toEqual(
      expect.objectContaining({ taskPath: 'TASKS/new.md', taskTitle: 'New Title' }),
    )
  })

  it('skips rewrite when no matching record exists', async () => {
    const { service, store, dataPath, vault } = createServiceWithStore()

    await service.renameTaskPath('TASKS/missing.md', 'TASKS/new.md')

    expect(vault.adapter.write).not.toHaveBeenCalled()
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
        exists: jest.fn(async (path: string) => store.has(path)),
        read: jest.fn(async (path: string) => store.get(path) ?? ''),
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

    expect(vault.adapter.write).toHaveBeenCalled()
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

describe('RunningTasksService.save - merge behavior', () => {
  const createRecord = (overrides: Partial<RunningTaskRecord> = {}): RunningTaskRecord => ({
    date: overrides.date ?? '2025-01-28',
    taskTitle: overrides.taskTitle ?? 'Task',
    taskPath: overrides.taskPath ?? 'TASKS/task.md',
    startTime: overrides.startTime ?? new Date('2025-01-28T09:00:00.000Z').toISOString(),
    instanceId: overrides.instanceId ?? 'inst-1',
    isRoutine: overrides.isRoutine ?? false,
  })

  const createInstance = (date: string, overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    task: {
      file: null,
      frontmatter: {},
      path: overrides.task?.path ?? 'TASKS/task.md',
      name: overrides.task?.name ?? 'Task',
      isRoutine: overrides.task?.isRoutine ?? false,
      taskId: overrides.task?.taskId ?? 'tc-task-1',
    },
    instanceId: overrides.instanceId ?? 'inst-1',
    state: 'running',
    slotKey: overrides.slotKey ?? 'none',
    startTime: new Date(`${date}T09:00:00.000Z`),
    createdMillis: Date.now(),
    ...overrides,
  })

  const createServiceWithStore = (initialRecords: RunningTaskRecord[] = []) => {
    const store = new Map<string, string>()
    const pathManager = { getLogDataPath: () => 'LOGS' }
    const dataPath = 'LOGS/running-task.json'

    if (initialRecords.length > 0) {
      store.set(dataPath, JSON.stringify(initialRecords, null, 2))
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
        exists: jest.fn(async (path: string) => store.has(path)),
        read: jest.fn(async (path: string) => store.get(path) ?? ''),
      },
    }

    const plugin = {
      app: { vault },
      pathManager,
    } as unknown as TaskChutePluginLike

    const service = new RunningTasksService(plugin)
    return { service, store, dataPath }
  }

  it('preserves records for other dates when saving', async () => {
    const existingRecord = createRecord({
      date: '2025-01-27',
      taskPath: 'TASKS/yesterday.md',
      instanceId: 'inst-yesterday',
    })
    const { service, store, dataPath } = createServiceWithStore([existingRecord])

    const todayInstance = createInstance('2025-01-28', {
      instanceId: 'inst-today',
      task: { file: null, frontmatter: {}, path: 'TASKS/today.md', name: 'Today Task', isRoutine: false, taskId: 'tc-today' },
    })

    await service.save([todayInstance], '2025-01-28')

    const result = JSON.parse(store.get(dataPath)!) as RunningTaskRecord[]
    expect(result).toHaveLength(2)
    expect(result.find(r => r.date === '2025-01-27')).toBeDefined()
    expect(result.find(r => r.date === '2025-01-28')).toBeDefined()
  })

  it('replaces records for the same date when saving', async () => {
    const existingRecord = createRecord({
      date: '2025-01-28',
      taskPath: 'TASKS/old.md',
      instanceId: 'inst-old',
    })
    const { service, store, dataPath } = createServiceWithStore([existingRecord])

    const newInstance = createInstance('2025-01-28', {
      instanceId: 'inst-new',
      task: { file: null, frontmatter: {}, path: 'TASKS/new.md', name: 'New Task', isRoutine: false, taskId: 'tc-new' },
    })

    await service.save([newInstance], '2025-01-28')

    const result = JSON.parse(store.get(dataPath)!) as RunningTaskRecord[]
    expect(result).toHaveLength(1)
    expect(result[0].instanceId).toBe('inst-new')
  })

  it('removes date records when no running instances for that date', async () => {
    const jan27 = createRecord({ date: '2025-01-27', instanceId: 'inst-27' })
    const jan28 = createRecord({ date: '2025-01-28', instanceId: 'inst-28' })
    const { service, store, dataPath } = createServiceWithStore([jan27, jan28])

    // Save empty array for 2025-01-28 (all tasks stopped)
    await service.save([], '2025-01-28')

    const result = JSON.parse(store.get(dataPath)!) as RunningTaskRecord[]
    expect(result).toHaveLength(1)
    expect(result[0].date).toBe('2025-01-27')
  })

  it('works when running-task.json does not exist yet', async () => {
    const { service, store, dataPath } = createServiceWithStore()

    const instance = createInstance('2025-01-28')
    await service.save([instance], '2025-01-28')

    const result = JSON.parse(store.get(dataPath)!) as RunningTaskRecord[]
    expect(result).toHaveLength(1)
    expect(result[0].date).toBe('2025-01-28')
  })

  it('uses the explicit view date instead of an older startTime date', async () => {
    const { service, store, dataPath } = createServiceWithStore()
    const instance = createInstance('2025-01-27', {
      instanceId: 'moved-running-instance',
      date: '2025-01-28',
    })

    await service.save([instance], '2025-01-28')

    const result = JSON.parse(store.get(dataPath)!) as RunningTaskRecord[]
    expect(result).toHaveLength(1)
    expect(result[0]?.date).toBe('2025-01-28')
    expect(result[0]?.startTime).toBe(instance.startTime?.toISOString())
  })
})

describe('RunningTasksService.moveRunningTaskToDateStrict', () => {
  const createRecord = (overrides: Partial<RunningTaskRecord> = {}): RunningTaskRecord => ({
    date: overrides.date ?? '2025-01-27',
    taskTitle: overrides.taskTitle ?? 'Task',
    taskPath: overrides.taskPath ?? 'TASKS/task.md',
    startTime: overrides.startTime ?? '2025-01-27T09:00:00.000Z',
    instanceId: overrides.instanceId ?? 'instance-1',
    taskId: overrides.taskId ?? 'task-1',
  })

  const createService = (
    initialContent: string | null,
    writeImplementation?: (path: string, content: string) => Promise<void>,
  ) => {
    let content = initialContent
    const adapter = {
      exists: jest.fn(async () => content !== null),
      read: jest.fn(async () => content ?? ''),
      write: jest.fn(async (path: string, next: string) => {
        if (writeImplementation) {
          await writeImplementation(path, next)
        }
        content = next
      }),
    }
    const plugin = {
      app: { vault: { adapter } },
      pathManager: { getLogDataPath: () => 'LOGS' },
    } as unknown as TaskChutePluginLike

    return {
      service: new RunningTasksService(plugin),
      adapter,
      readRecords: () => JSON.parse(content ?? '[]') as RunningTaskRecord[],
    }
  }

  it('moves only the exact instance when sibling records share task identity', async () => {
    const records = [
      createRecord({ instanceId: 'move-me' }),
      createRecord({ instanceId: 'keep-me' }),
    ]
    const { service, readRecords } = createService(JSON.stringify(records))

    const moved = await service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'move-me',
      taskId: 'task-1',
      taskPath: 'TASKS/task.md',
    })

    expect(moved).toBe(1)
    expect(readRecords()).toEqual([
      expect.objectContaining({ instanceId: 'move-me', date: '2025-01-28' }),
      expect.objectContaining({ instanceId: 'keep-me', date: '2025-01-27' }),
    ])
  })

  it('does not fall back to taskId or path when a supplied instanceId is absent', async () => {
    const { service, adapter, readRecords } = createService(JSON.stringify([
      createRecord({ instanceId: 'sibling' }),
    ]))

    const moved = await service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'missing',
      taskId: 'task-1',
      taskPath: 'TASKS/task.md',
    })

    expect(moved).toBe(0)
    expect(adapter.write).not.toHaveBeenCalled()
    expect(readRecords()[0]?.date).toBe('2025-01-27')
  })

  it('returns zero without writing when no persisted record matches', async () => {
    const { service, adapter } = createService(JSON.stringify([
      createRecord({ instanceId: 'other', taskPath: 'TASKS/other.md' }),
    ]))

    await expect(service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'missing',
    })).resolves.toBe(0)
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and leaves storage untouched', async () => {
    const { service, adapter } = createService('{not-json')

    await expect(service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'instance-1',
    })).rejects.toBeInstanceOf(SyntaxError)
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('rejects a non-array JSON root instead of replacing corrupted storage', async () => {
    const { service, adapter } = createService(JSON.stringify({ records: [] }))

    await expect(service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'instance-1',
    })).rejects.toThrow('running-task.json must contain an array')
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('propagates write failures so callers can abort restoration', async () => {
    const { service } = createService(
      JSON.stringify([createRecord()]),
      async () => {
        throw new Error('disk full')
      },
    )

    await expect(service.moveRunningTaskToDateStrict({
      targetDate: '2025-01-28',
      instanceId: 'instance-1',
    })).rejects.toThrow('disk full')
  })

  it.each(['2025-02-30', '2025/01/28', ''])(
    'rejects invalid target date %p before reading storage',
    async (targetDate) => {
      const { service, adapter } = createService(JSON.stringify([createRecord()]))

      await expect(service.moveRunningTaskToDateStrict({
        targetDate,
        instanceId: 'instance-1',
      })).rejects.toThrow('Invalid running-task target date')
      expect(adapter.exists).not.toHaveBeenCalled()
    },
  )
})
