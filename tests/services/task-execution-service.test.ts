import { TFile } from 'obsidian'
import TaskExecutionService from '../../src/features/core/services/TaskExecutionService'
import { HeatmapService } from '../../src/features/log/services/HeatmapService'
import type { TaskExecutionHost } from '../../src/features/core/services/TaskExecutionService'
import type { TaskInstance, TaskChutePluginLike } from '../../src/types'

describe('TaskExecutionService', () => {
  beforeEach(() => {
    jest.spyOn(HeatmapService.prototype, 'updateDailyStats').mockResolvedValue(undefined)
  })

  afterEach(() => {
    try {
      jest.useRealTimers()
    } catch {
      /* no-op if timers were not mocked */
    }
    jest.clearAllMocks()
  })

  const createHost = (overrides: Partial<TaskExecutionHost> = {}): TaskExecutionHost => {
    const plugin = {
      app: {
        vault: { getAbstractFileByPath: jest.fn(), read: jest.fn() },
        fileManager: { processFrontMatter: jest.fn(), trashFile: jest.fn() },
      },
      pathManager: {
        getLogDataPath: jest.fn(() => '/logs'),
        getLogYearPath: jest.fn(() => '/logs/2025'),
        ensureYearFolder: jest.fn(async () => '/logs/2025'),
        getReviewDataPath: jest.fn(() => '/review'),
      },
    } as unknown as TaskChutePluginLike

    const host: TaskExecutionHost = {
      tv: (key, fallback) => fallback,
      app: plugin.app,
      plugin,
      getViewDate: () => new Date('2025-01-02T00:00:00.000Z'),
      getCurrentDateString: () => '2025-01-02',
      getInstanceDisplayTitle: () => 'Sample',
      renderTaskList: jest.fn(),
      startGlobalTimer: jest.fn(),
      restartTimerService: jest.fn(),
      stopTimers: jest.fn(),
      saveRunningTasksState: jest.fn().mockResolvedValue(undefined),
      removeRunningTaskRecord: jest.fn().mockResolvedValue(undefined),
      sortTaskInstancesByTimeOrder: jest.fn(),
      saveTaskOrders: jest.fn().mockResolvedValue(undefined),
      executionLogService: { saveTaskLog: jest.fn().mockResolvedValue(undefined) },
      handleCrossDayStart: jest.fn().mockResolvedValue(undefined),
      setCurrentInstance: jest.fn(),
      getCurrentInstance: jest.fn().mockReturnValue(null),
      hasRunningInstances: jest.fn().mockReturnValue(true),
      calculateCrossDayDuration: jest.fn().mockReturnValue(3_600_000),
      ...overrides,
    }

    return host
  }

  const createMockTFile = (path: string): TFile => {
    const file = new TFile()
    const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? {}
    if (Object.getPrototypeOf(file) !== proto) {
      Object.setPrototypeOf(file, proto)
    }
    if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
      (file as { constructor?: unknown }).constructor = TFile
    }
    file.path = path
    file.basename = path.split('/').pop() ?? 'task'
    file.extension = 'md'
    return file
  }

  it('starts instance and persists running state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-02T09:00:00.000Z'))
    const host = createHost()
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/sample.md',
        name: 'Sample',
      },
      instanceId: 'inst-1',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(instance.state).toBe('running')
    expect(instance.startTime).toBeInstanceOf(Date)
    expect(host.handleCrossDayStart).not.toHaveBeenCalled()
    expect(host.saveRunningTasksState).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(host.restartTimerService).toHaveBeenCalled()
    expect(host.stopTimers).not.toHaveBeenCalled()
    expect(host.setCurrentInstance).toHaveBeenCalledWith(instance)
    expect(host.startGlobalTimer).toHaveBeenCalled()
  })

  it('stops instance and writes execution log', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-02T12:00:00.000Z'))

    const host = createHost({
      getCurrentInstance: jest.fn().mockReturnValue({} as TaskInstance),
      hasRunningInstances: jest.fn().mockReturnValue(false),
    })
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/sample.md',
        name: 'Sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'running',
      slotKey: 'none',
      startTime: new Date('2025-01-01T08:00:00.000Z'),
    }

    await service.stopInstance(instance)

    expect(instance.state).toBe('done')
    expect(instance.stopTime).toBeInstanceOf(Date)
    expect(instance.actualMinutes).toBe(60)
    expect(instance.executedTitle).toBe('Sample')
    expect(host.executionLogService.saveTaskLog).toHaveBeenCalledWith(instance, 3600)
    expect(host.removeRunningTaskRecord).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      taskPath: 'TASKS/sample.md',
      taskId: 'tc-task-sample',
    })
    expect(host.sortTaskInstancesByTimeOrder).toHaveBeenCalled()
    expect(host.saveTaskOrders).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(host.stopTimers).toHaveBeenCalled()
    expect(host.restartTimerService).not.toHaveBeenCalled()
  })

  it('moves cross-day non-routine tasks to today immediately', async () => {
    const current = new Date('2025-01-02T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const handleCrossDayStart = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      handleCrossDayStart,
      renderTaskList: jest.fn(),
    })
    const mockFile = createMockTFile('TASKS/past.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)
    ;(host.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (_file: TFile, cb: (frontmatter: Record<string, unknown>) => Record<string, unknown>) => {
        cb({})
      },
    )
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/past.md',
        name: 'Past Task',
      },
      instanceId: 'inst-1',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(handleCrossDayStart).toHaveBeenCalledTimes(1)
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      mockFile,
      expect.any(Function),
    )
    const [payload] = handleCrossDayStart.mock.calls[0]
    expect(payload.instance).toBe(instance)
    expect(payload.today.getFullYear()).toBe(2025)
    expect(payload.today.getMonth()).toBe(0)
    expect(payload.today.getDate()).toBe(2)
    expect(payload.todayKey).toBe('2025-01-02')
    expect(instance.state).toBe('running')
    expect(instance.date).toBe('2025-01-02')
    expect(host.saveRunningTasksState).not.toHaveBeenCalled()
  })

  it('sets target_date for cross-day routine tasks', async () => {
    const current = new Date('2025-01-02T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const handleCrossDayStart = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      handleCrossDayStart,
      renderTaskList: jest.fn(),
    })
    const mockFile = createMockTFile('TASKS/routine.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)
    ;(host.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (_file: TFile, cb: (frontmatter: Record<string, unknown>) => Record<string, unknown>) => {
        cb({})
      },
    )
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/routine.md',
        name: 'Routine Task',
        isRoutine: true,
      },
      instanceId: 'inst-1',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(handleCrossDayStart).toHaveBeenCalledTimes(1)
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      mockFile,
      expect.any(Function),
    )
    const [payload] = handleCrossDayStart.mock.calls[0]
    expect(payload.instance).toBe(instance)
    expect(payload.todayKey).toBe('2025-01-02')
    expect(instance.state).toBe('running')
    expect(instance.date).toBe('2025-01-02')
    expect(host.saveRunningTasksState).not.toHaveBeenCalled()
  })

  it('cross-day routine start sets target_date to todayKey in frontmatter', async () => {
    const current = new Date('2025-02-22T01:22:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const capturedFrontmatter: Record<string, unknown> = {}
    const handleCrossDayStart = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      getViewDate: () => new Date('2025-02-21T00:00:00.000Z'),
      handleCrossDayStart,
      renderTaskList: jest.fn(),
    })
    const mockFile = createMockTFile('TASKS/english.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)
    ;(host.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (_file: TFile, cb: (frontmatter: Record<string, unknown>) => Record<string, unknown>) => {
        cb(capturedFrontmatter)
      },
    )
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/english.md',
        name: 'English Conversation',
        isRoutine: true,
      },
      instanceId: 'inst-eng',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(capturedFrontmatter.target_date).toBe('2025-02-22')
    expect(instance.date).toBe('2025-02-22')
  })

  it('does not set target_date for cross-day duplicated routine tasks', async () => {
    const current = new Date('2025-01-02T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const handleCrossDayStart = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      handleCrossDayStart,
      renderTaskList: jest.fn(),
    }) as TaskExecutionHost & {
      isDuplicateInstance?: (inst: TaskInstance) => boolean
    }
    host.isDuplicateInstance = jest.fn().mockReturnValue(true)

    const mockFile = createMockTFile('TASKS/routine.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)
    ;(host.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (_file: TFile, cb: (frontmatter: Record<string, unknown>) => Record<string, unknown>) => {
        cb({})
      },
    )
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/routine.md',
        name: 'Routine Task',
        isRoutine: true,
      },
      instanceId: 'inst-dup-routine',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(host.isDuplicateInstance).toHaveBeenCalledWith(instance)
    expect(host.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
    expect(handleCrossDayStart).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('running')
    expect(instance.date).toBe('2025-01-02')
  })

  it('cross-day routine start completes even if processFrontMatter fails', async () => {
    const current = new Date('2025-01-02T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const handleCrossDayStart = jest.fn().mockResolvedValue(undefined)
    const host = createHost({
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      handleCrossDayStart,
      renderTaskList: jest.fn(),
    })
    const mockFile = createMockTFile('TASKS/routine.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)
    ;(host.app.fileManager.processFrontMatter as jest.Mock).mockRejectedValue(
      new Error('file locked'),
    )
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/routine.md',
        name: 'Routine Task',
        isRoutine: true,
      },
      instanceId: 'inst-1',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(handleCrossDayStart).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('running')
    expect(instance.date).toBe('2025-01-02')
  })

  it('does not resave running tasks after handleCrossDayStart for routine cross-day start', async () => {
    const current = new Date('2025-01-02T09:00:00.000Z')
    jest.useFakeTimers().setSystemTime(current)

    const host = createHost({
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      handleCrossDayStart: jest.fn().mockImplementation(async () => {
        return undefined
      }),
      saveRunningTasksState: jest.fn().mockImplementation(async () => {
        return undefined
      }),
      renderTaskList: jest.fn().mockImplementation(() => {
        return undefined
      }),
    })
    const mockFile = createMockTFile('TASKS/routine.md')
    ;(host.app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile)

    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/routine.md',
        name: 'Routine Task',
        isRoutine: true,
      },
      instanceId: 'inst-1',
      state: 'idle',
      slotKey: 'none',
    }

    await service.startInstance(instance)

    expect(host.saveRunningTasksState).not.toHaveBeenCalled()
    expect(host.renderTaskList).not.toHaveBeenCalled()
  })

  it('stopInstance skips timer control on past-date view', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-03T12:00:00.000Z'))

    const host = createHost({
      // viewDate is Jan 2 (yesterday), system is Jan 3 (today)
      getViewDate: () => new Date('2025-01-02T00:00:00.000Z'),
      getCurrentInstance: jest.fn().mockReturnValue(null),
      hasRunningInstances: jest.fn().mockReturnValue(false),
    })
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/sample.md',
        name: 'Sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'running',
      slotKey: 'none',
      startTime: new Date('2025-01-02T08:00:00.000Z'),
    }

    await service.stopInstance(instance)

    expect(instance.state).toBe('done')
    expect(host.executionLogService.saveTaskLog).toHaveBeenCalled()
    expect(host.saveRunningTasksState).toHaveBeenCalled()
    // Timer control should NOT happen on past-date view
    expect(host.stopTimers).not.toHaveBeenCalled()
    expect(host.restartTimerService).not.toHaveBeenCalled()
  })

  it('handles heatmap update failure gracefully', async () => {
    const host = createHost({
      plugin: {
        app: {
          vault: { getAbstractFileByPath: jest.fn(), read: jest.fn() },
          fileManager: { processFrontMatter: jest.fn(), trashFile: jest.fn() },
        },
        pathManager: {
          getLogDataPath: jest.fn(),
          getLogYearPath: jest.fn(),
          ensureYearFolder: jest.fn(),
          getReviewDataPath: jest.fn(),
        },
      } as unknown as TaskChutePluginLike,
    })
    const service = new TaskExecutionService(host)
    const instance: TaskInstance = {
      task: {
        file: null,
        frontmatter: {},
        path: 'TASKS/sample.md',
        name: 'Sample',
      },
      instanceId: 'inst-1',
      state: 'running',
      slotKey: 'none',
      startTime: new Date('2025-01-01T08:00:00.000Z'),
    }

    jest
      .spyOn(HeatmapService.prototype, 'updateDailyStats')
      .mockRejectedValueOnce(new Error('network'))

    await expect(service.stopInstance(instance)).resolves.toBeUndefined()
  })
})
