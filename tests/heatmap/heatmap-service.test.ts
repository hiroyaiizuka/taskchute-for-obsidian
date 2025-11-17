import { App, TFile } from 'obsidian'
import { HeatmapService, HeatmapServicePluginLike } from '../../src/features/log/services/HeatmapService'

function createTFile(path: string) {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop() ?? path
  Object.setPrototypeOf(file, TFile.prototype)
  return file
}

function createPathManager() {
  return {
    getLogDataPath: () => 'LOGS',
    getLogYearPath: (year: number | string) => `LOGS/${year}`,
    ensureYearFolder: jest.fn(async (year: number | string) => `LOGS/${year}`),
    ensureFolderExists: jest.fn(async () => undefined),
    getReviewDataPath: () => 'REVIEWS',
  }
}

function createVault(store: Map<string, string>) {
  return {
    getAbstractFileByPath: jest.fn((path: string) => {
      if (store.has(path)) {
        return createTFile(path)
      }
      return null
    }),
    read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
    create: jest.fn(async (path: string, content: string) => {
      store.set(path, content)
      return createTFile(path)
    }),
    modify: jest.fn(async (file: TFile, content: string) => {
      store.set(file.path, content)
    }),
  }
}

describe('HeatmapService', () => {
  beforeAll(() => {
    jest.useFakeTimers()
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  beforeEach(() => {
    jest.setSystemTime(new Date('2025-09-26T09:00:00Z'))
  })

  test('omits future days from yearly data', async () => {
    const store = new Map<string, string>()

    const pathManager = createPathManager()

    const vault = createVault(store)

    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const monthlyPath = 'LOGS/2025-09-tasks.json'
    store.set(
      monthlyPath,
      JSON.stringify({
        taskExecutions: {},
        dailySummary: {
          '2025-09-25': { totalTasks: 5, completedTasks: 4 },
          '2025-09-27': { totalTasks: 2, completedTasks: 1 },
        },
      }),
    )

    const data = await service.generateYearlyData(2025)
    expect(data.days['2025-09-25']).toBeDefined()
    expect(data.days['2025-09-27']).toBeUndefined()

    const yearlyPath = 'LOGS/heatmap/2025/yearly-heatmap.json'
    const written = JSON.parse(store.get(yearlyPath) ?? '{}')
    expect(written.days?.['2025-09-27']).toBeUndefined()
  })

  test('loadYearlyData migrates legacy `.heatmap` cache into visible folder', async () => {
    const store = new Map<string, string>()
    const pathManager = createPathManager()
    const vault = createVault(store)
    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const legacyPath = 'LOGS/.heatmap/2024/yearly-heatmap.json'
    const legacyPayload = {
      year: 2024,
      days: {
        '2024-01-01': { totalTasks: 1, completedTasks: 1, procrastinatedTasks: 0, completionRate: 1 },
      },
      metadata: { version: '1.0', lastUpdated: '2024-01-02T00:00:00.000Z' },
    }
    store.set(legacyPath, JSON.stringify(legacyPayload))

    const data = await service.loadYearlyData(2024)
    expect(data.days['2024-01-01']?.totalTasks).toBe(1)

    const visiblePath = 'LOGS/heatmap/2024/yearly-heatmap.json'
    expect(store.has(visiblePath)).toBe(true)
    const migrated = JSON.parse(store.get(visiblePath) ?? '{}')
    expect(migrated.days?.['2024-01-01']?.completedTasks).toBe(1)
  })

  test('loadYearlyData migrates legacy year-folder cache into heatmap folder', async () => {
    const store = new Map<string, string>()
    const pathManager = createPathManager()
    const vault = createVault(store)
    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const legacyPath = 'LOGS/2023/yearly-heatmap.json'
    store.set(
      legacyPath,
      JSON.stringify({
        year: 2023,
        days: { '2023-02-02': { totalTasks: 2, completedTasks: 1, procrastinatedTasks: 1, completionRate: 0.5 } },
        metadata: { version: '1.0' },
      }),
    )

    const data = await service.loadYearlyData(2023)
    expect(data.days['2023-02-02']?.totalTasks).toBe(2)

    const visiblePath = 'LOGS/heatmap/2023/yearly-heatmap.json'
    expect(store.has(visiblePath)).toBe(true)
    const migrated = JSON.parse(store.get(visiblePath) ?? '{}')
    expect(migrated.days?.['2023-02-02']?.procrastinatedTasks).toBe(1)
  })

  test('recalculates completed tasks from executions when summary is stale', async () => {
    const store = new Map<string, string>()

    const pathManager = createPathManager()

    const vault = createVault(store)

    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const monthPath = 'LOGS/2025-09-tasks.json'
    const entries = [
      {
        taskTitle: 'Taskchute for Local 開発',
        taskPath: '02_Config/TaskChute/Task/Taskchute for Local 開発.md',
        instanceId: 'task-1',
        startTime: '08:00:00',
        stopTime: '09:00:00',
        durationSec: 3600,
      },
      {
        taskTitle: 'Taskchute for Local 開発',
        taskPath: '02_Config/TaskChute/Task/Taskchute for Local 開発.md',
        instanceId: 'task-2',
        startTime: '10:00:00',
        stopTime: '11:00:00',
        durationSec: 3600,
      },
      {
        taskTitle: 'Taskchute for Local 開発',
        taskPath: '02_Config/TaskChute/Task/Taskchute for Local 開発.md',
        instanceId: 'task-3',
        startTime: '12:00:00',
        stopTime: '13:00:00',
        durationSec: 3600,
      },
    ]

    store.set(
      monthPath,
      JSON.stringify({
        taskExecutions: {
          '2025-09-23': entries,
        },
        dailySummary: {
          '2025-09-23': { totalTasks: 3, completedTasks: 1 },
        },
      }),
    )

    const yearly = await service.generateYearlyData(2025)
    expect(yearly.days['2025-09-23']?.completedTasks).toBe(3)
    expect(yearly.days['2025-09-23']?.totalTasks).toBe(3)

    const updatedMonth = JSON.parse(store.get(monthPath) ?? '{}')
    expect(updatedMonth.dailySummary['2025-09-23'].completedTasks).toBe(3)
    expect(updatedMonth.dailySummary['2025-09-23'].procrastinatedTasks).toBe(0)
    expect(updatedMonth.dailySummary['2025-09-23'].completionRate).toBe(1)
  })

  test('calculateDailyStats distinguishes incomplete tasks', () => {
    const pathManager = createPathManager()

    const vault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      create: jest.fn(),
      modify: jest.fn(),
    }

    const plugin: HeatmapServicePluginLike = {
      app: { vault } as unknown as App,
      pathManager,
    }

    const service = new HeatmapService(plugin)

    const stats = service.calculateDailyStats([
      {
        instanceId: 'task-1',
        taskTitle: '未完了タスク',
        isCompleted: false,
      },
      {
        instanceId: 'task-2',
        taskTitle: '文字列falseタスク',
        isCompleted: 'false',
      },
      {
        instanceId: 'task-3',
        taskTitle: '進捗あり',
        stopTime: '10:00:00',
      },
      {
        instanceId: 'task-4',
        taskTitle: 'durationあり',
        durationSec: 1800,
      },
      {
        instanceId: 'task-5',
        taskTitle: '完了文字列',
        isCompleted: 'done',
      },
    ])

    expect(stats.totalTasks).toBe(5)
    expect(stats.completedTasks).toBe(3)
    expect(stats.procrastinatedTasks).toBe(2)
    expect(stats.completionRate).toBeCloseTo(0.6, 5)
  })

  test('loadDayDetail returns satisfaction, averages, and sorted executions', async () => {
    const store = new Map<string, string>()

    const pathManager = createPathManager()

    const vault = createVault(store)

    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const monthPath = 'LOGS/2025-09-tasks.json'
    store.set(
      monthPath,
      JSON.stringify({
        taskExecutions: {
          '2025-09-23': [
            {
              taskTitle: 'タスクB',
              instanceId: 'two',
              startTime: '13:00:00',
              stopTime: '14:10:00',
              durationSec: 4200,
              focusLevel: 4,
              energyLevel: 3,
              executionComment: '午後作業',
              isCompleted: true,
            },
            {
              taskTitle: 'タスクA',
              instanceId: 'one',
              startTime: '09:00:00',
              stopTime: '09:45:00',
              durationSec: 2700,
              focusLevel: 5,
              energyLevel: 5,
              executionComment: '朝の集中タイム',
              isCompleted: true,
              project: 'Daily Review',
            },
          ],
        },
        dailySummary: {
          '2025-09-23': {
            totalTasks: 2,
            completedTasks: 2,
            totalMinutes: 115,
            procrastinatedTasks: 0,
            completionRate: 1,
          },
        },
      }),
    )

    const reviewPath = 'REVIEWS/Daily - 2025-09-23.md'
    store.set(
      reviewPath,
      ['---', 'satisfaction: 4', 'mood: good', '---', '', 'notes: great day'].join('\n'),
    )

    const detail = await service.loadDayDetail('2025-09-23')
    expect(detail).not.toBeNull()
    if (!detail) return
    expect(detail.satisfaction).toBe(4)
    expect(detail.summary.totalTasks).toBe(2)
    expect(detail.summary.totalMinutes).toBe(115)
    expect(detail.summary.avgFocusLevel).toBeCloseTo(4.5)
    expect(detail.summary.avgEnergyLevel).toBeCloseTo(4)
    expect(detail.executions).toHaveLength(2)
    expect(detail.executions[0].title).toBe('タスクA')
    expect(detail.executions[0].startTime).toBe('09:00:00')
    expect(detail.executions[0].durationSec).toBe(2700)
    expect(detail.executions[0].focusLevel).toBe(5)
    expect(detail.executions[0].project).toBe('Daily Review')
    expect(detail.executions[0].taskPath).toBeUndefined()
    expect(detail.executions[1].title).toBe('タスクB')
  })

  test('loadDayDetail returns null for future dates', async () => {
    const pathManager = createPathManager()

    const vault = {
      getAbstractFileByPath: jest.fn(() => null),
      read: jest.fn(),
      create: jest.fn(),
      modify: jest.fn(),
    }

    const plugin: HeatmapServicePluginLike = { app: { vault }, pathManager }
    const service = new HeatmapService(plugin)

    const result = await service.loadDayDetail('2099-01-01')
    expect(result).toBeNull()
  })
})
