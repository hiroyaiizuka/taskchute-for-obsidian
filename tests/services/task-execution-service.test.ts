import TaskExecutionService from '../../src/services/TaskExecutionService'
import { HeatmapService } from '../../src/services/HeatmapService'
import type { TaskExecutionHost } from '../../src/services/TaskExecutionService'
import type { TaskInstance, TaskChutePluginLike } from '../../src/types'

describe('TaskExecutionService', () => {
  beforeEach(() => {
    jest.spyOn(HeatmapService.prototype, 'updateDailyStats').mockResolvedValue(undefined)
  })

  afterEach(() => {
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
      getViewDate: () => new Date('2025-01-01T00:00:00.000Z'),
      getCurrentDateString: () => '2025-01-01',
      getInstanceDisplayTitle: () => 'Sample',
      renderTaskList: jest.fn(),
      startGlobalTimer: jest.fn(),
      restartTimerService: jest.fn(),
      stopTimers: jest.fn(),
      saveRunningTasksState: jest.fn().mockResolvedValue(undefined),
      sortTaskInstancesByTimeOrder: jest.fn(),
      saveTaskOrders: jest.fn().mockResolvedValue(undefined),
      executionLogService: { saveTaskLog: jest.fn().mockResolvedValue(undefined) },
      setCurrentInstance: jest.fn(),
      getCurrentInstance: jest.fn().mockReturnValue(null),
      hasRunningInstances: jest.fn().mockReturnValue(true),
      calculateCrossDayDuration: jest.fn().mockReturnValue(3_600_000),
      ...overrides,
    }

    return host
  }

  it('starts instance and persists running state', async () => {
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
    expect(host.saveRunningTasksState).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(host.restartTimerService).toHaveBeenCalled()
    expect(host.stopTimers).not.toHaveBeenCalled()
    expect(host.setCurrentInstance).toHaveBeenCalledWith(instance)
    expect(host.startGlobalTimer).toHaveBeenCalled()
  })

  it('stops instance and writes execution log', async () => {
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
    expect(host.executionLogService.saveTaskLog).toHaveBeenCalledWith(instance, 3600)
    expect(host.sortTaskInstancesByTimeOrder).toHaveBeenCalled()
    expect(host.saveTaskOrders).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(host.stopTimers).toHaveBeenCalled()
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
