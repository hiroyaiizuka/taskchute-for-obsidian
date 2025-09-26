import { TFile } from 'obsidian'
import { HeatmapService, HeatmapServicePluginLike } from '../../src/services/HeatmapService'

function createTFile(path: string) {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop() ?? path
  Object.setPrototypeOf(file, TFile.prototype)
  return file
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

    const pathManager = {
      getLogDataPath: () => 'LOGS',
      getLogYearPath: (year: number | string) => `LOGS/${year}`,
      ensureYearFolder: jest.fn(async (year: number | string) => `LOGS/${year}`),
    }

    const vault = {
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

    const yearlyPath = 'LOGS/2025/yearly-heatmap.json'
    const written = JSON.parse(store.get(yearlyPath) ?? '{}')
    expect(written.days?.['2025-09-27']).toBeUndefined()
  })

  test('recalculates completed tasks from executions when summary is stale', async () => {
    const store = new Map<string, string>()

    const pathManager = {
      getLogDataPath: () => 'LOGS',
      getLogYearPath: (year: number | string) => `LOGS/${year}`,
      ensureYearFolder: jest.fn(async (year: number | string) => `LOGS/${year}`),
    }

    const vault = {
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
})
