// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  Notice: jest.fn(),
  PluginSettingTab: jest.fn(),
  Setting: jest.fn(),
  normalizePath: jest.fn(path => path)
}))

const { TFile } = require('obsidian')
const { DailyTaskAggregator } = require('../main')

describe('DailyTaskAggregator', () => {
  let plugin
  let aggregator
  let mockApp

  beforeEach(() => {
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn()
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
      }
    }

    plugin = {
      app: mockApp,
      pathManager: {
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log'),
        ensureYearFolder: jest.fn().mockResolvedValue('TaskChute/Log/2025')
      },
      view: null
    }

    aggregator = new DailyTaskAggregator(plugin)
  })

  describe('calculateDailyStats', () => {
    test('should return empty stats for null or invalid input', () => {
      expect(aggregator.calculateDailyStats(null)).toEqual({
        totalTasks: 0,
        completedTasks: 0,
        procrastinatedTasks: 0,
        completionRate: 0
      })

      expect(aggregator.calculateDailyStats(undefined)).toEqual({
        totalTasks: 0,
        completedTasks: 0,
        procrastinatedTasks: 0,
        completionRate: 0
      })

      expect(aggregator.calculateDailyStats('not an array')).toEqual({
        totalTasks: 0,
        completedTasks: 0,
        procrastinatedTasks: 0,
        completionRate: 0
      })
    })

    test('should calculate stats for valid tasks', () => {
      const dayTasks = [
        { taskName: 'Task 1', isCompleted: true },
        { taskName: 'Task 2', isCompleted: false },
        { taskName: 'Task 3', isCompleted: true },
        { taskName: 'Task 1', isCompleted: true } // Duplicate should be counted once
      ]

      const stats = aggregator.calculateDailyStats(dayTasks)

      expect(stats.totalTasks).toBe(3) // Unique tasks (Task 1, Task 2, and Task 3)
      expect(stats.completedTasks).toBe(2) // Task 1 and Task 3 are completed
      expect(stats.procrastinatedTasks).toBe(1) // Task 2 is not completed
      expect(stats.completionRate).toBeCloseTo(0.67, 2)
    })

    test('should handle tasks with missing or invalid data', () => {
      const dayTasks = [
        { taskName: 'Valid Task', isCompleted: true },
        { taskName: null, isCompleted: true }, // Invalid name
        { isCompleted: true }, // Missing name
        { taskName: 'Another Task' }, // Missing isCompleted
        { taskName: '', isCompleted: false }, // Empty name
        'not an object', // Invalid task
        null // Null task
      ]

      const stats = aggregator.calculateDailyStats(dayTasks)

      expect(stats.totalTasks).toBe(2) // 'Valid Task' and 'Another Task'
      expect(stats.completedTasks).toBe(1) // Only 'Valid Task' is completed
    })

    test('should calculate correct completion rate', () => {
      const dayTasks = [
        { taskName: 'Task 1', isCompleted: true },
        { taskName: 'Task 2', isCompleted: true },
        { taskName: 'Task 3', isCompleted: false },
        { taskName: 'Task 4', isCompleted: false }
      ]

      const stats = aggregator.calculateDailyStats(dayTasks)

      expect(stats.totalTasks).toBe(4)
      expect(stats.completedTasks).toBe(2)
      expect(stats.procrastinatedTasks).toBe(2)
      expect(stats.completionRate).toBe(0.5)
    })
  })

  describe('loadMonthlyData', () => {
    test('should load monthly data from file', async () => {
      const monthlyData = {
        taskExecutions: {
          '2025-01-01': [
            { taskName: 'Task 1', isCompleted: true }
          ]
        }
      }
      
      // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(monthlyData))

      const result = await aggregator.loadMonthlyData('2025-01-01')

      expect(result).toEqual(monthlyData)
      expect(mockApp.vault.read).toHaveBeenCalledWith(mockFile)
    })

    test('should return empty object if file does not exist', async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      const result = await aggregator.loadMonthlyData('2025-01-01')

      expect(result).toEqual({ taskExecutions: {} })
    })

    test('should handle invalid date format', async () => {
      const result = await aggregator.loadMonthlyData('invalid-date')

      expect(result).toEqual({ taskExecutions: {} })
    })
  })

  describe('updateDailyStats', () => {
    test('should update daily stats and yearly data', async () => {
      const monthlyData = {
        taskExecutions: {
          '2025-01-01': [
            { taskName: 'Task 1', isCompleted: true },
            { taskName: 'Task 2', isCompleted: false }
          ]
        }
      }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(monthlyData))

      aggregator.updateYearlyData = jest.fn()

      const stats = await aggregator.updateDailyStats('2025-01-01')

      expect(stats).toEqual({
        totalTasks: 2,
        completedTasks: 1,
        procrastinatedTasks: 1,
        completionRate: 0.5
      })

      expect(aggregator.updateYearlyData).toHaveBeenCalledWith('2025-01-01', stats)
    })

    test('should handle errors gracefully', async () => {
      mockApp.vault.getAbstractFileByPath.mockImplementation(() => {
        throw new Error('Read error')
      })

      const stats = await aggregator.updateDailyStats('2025-01-01')

      // loadMonthlyData catches the error and returns empty data
      // So updateDailyStats returns default stats, not null
      expect(stats).toEqual({
        totalTasks: 0,
        completedTasks: 0,
        procrastinatedTasks: 0,
        completionRate: 0
      })
    })
  })

  describe('updateYearlyData', () => {
    test('should create new yearly data if not exists', async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      const stats = {
        totalTasks: 5,
        completedTasks: 3,
        procrastinatedTasks: 2,
        completionRate: 0.6
      }

      await aggregator.updateYearlyData('2025-01-01', stats)

      expect(mockApp.vault.create).toHaveBeenCalledWith(
        'TaskChute/Log/2025/yearly-heatmap.json',
        expect.stringContaining('"year": 2025')
      )

      const writtenData = JSON.parse(mockApp.vault.create.mock.calls[0][1])
      expect(writtenData.days['2025-01-01']).toEqual(stats)
    })

    test('should update existing yearly data', async () => {
      const existingData = {
        year: 2025,
        days: {
          '2025-01-01': { totalTasks: 3, completedTasks: 2 }
        },
        metadata: { version: '1.0' }
      }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(existingData))

      const newStats = {
        totalTasks: 5,
        completedTasks: 4,
        procrastinatedTasks: 1,
        completionRate: 0.8
      }

      await aggregator.updateYearlyData('2025-01-02', newStats)

      const writtenData = JSON.parse(mockApp.vault.modify.mock.calls[0][1])
      expect(writtenData.days['2025-01-01']).toEqual(existingData.days['2025-01-01'])
      expect(writtenData.days['2025-01-02']).toEqual(newStats)
    })

    test('should update cache if LogView exists', async () => {
      const cachedData = { year: 2025, days: {}, metadata: { version: '1.0' } }
      const logView = { dataCache: { 2025: cachedData } }
      plugin.view = { logView }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(cachedData))
      mockApp.vault.modify.mockResolvedValue()

      await aggregator.updateYearlyData('2025-01-01', {
        totalTasks: 1,
        completedTasks: 1
      })

      // Write should have been called with updated data
      const writtenData = JSON.parse(mockApp.vault.modify.mock.calls[0][1])
      expect(writtenData.days['2025-01-01']).toEqual({
        totalTasks: 1,
        completedTasks: 1
      })
      
      // Cache should be updated
      expect(plugin.view.logView.dataCache['2025'].days['2025-01-01']).toEqual({
        totalTasks: 1,
        completedTasks: 1
      })
    })
  })
})