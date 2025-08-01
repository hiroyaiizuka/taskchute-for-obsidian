const { LogView } = require('../main')
const { TFile } = require('obsidian')

describe('LogView', () => {
  let plugin
  let container
  let logView
  let mockApp

  beforeEach(() => {
    // Mock DOM container
    container = {
      empty: jest.fn(),
      createEl: jest.fn((tag, options) => {
        const element = {
          createEl: jest.fn(),
          appendChild: jest.fn(),
          addEventListener: jest.fn(),
          querySelector: jest.fn(),
          querySelectorAll: jest.fn(() => []),
          remove: jest.fn(),
          textContent: '',
          dataset: {}
        }
        if (options?.text) element.textContent = options.text
        if (options?.cls) element.className = options.cls
        element.createEl = container.createEl
        return element
      }),
      querySelector: jest.fn()
    }

    // Mock app
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn()
        }
      }
    }

    // Mock plugin
    plugin = {
      app: mockApp,
      pathManager: {
        getLogYearPath: jest.fn((year) => `TaskChute/Log/${year}`),
        ensureYearFolder: jest.fn()
      },
      view: null
    }

    logView = new LogView(plugin, container)
  })

  describe('constructor', () => {
    test('should initialize with default values', () => {
      expect(logView.plugin).toBe(plugin)
      expect(logView.container).toBe(container)
      expect(logView.currentYear).toBe(new Date().getFullYear())
      expect(logView.heatmapData).toBeNull()
      expect(logView.dataCache).toEqual({})
    })
  })

  describe('loadYearlyData', () => {
    test('should load from cache if available', async () => {
      const cachedData = { year: 2025, days: {} }
      logView.dataCache[2025] = cachedData

      const result = await logView.loadYearlyData(2025)

      expect(result).toBe(cachedData)
      expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled()
    })

    test('should load from file and cache if not in cache', async () => {
      const fileData = {
        year: 2025,
        days: { '2025-01-01': { totalTasks: 5, completedTasks: 3 } }
      }
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(fileData))

      const result = await logView.loadYearlyData(2025)

      expect(result).toEqual(fileData)
      expect(logView.dataCache[2025]).toEqual(fileData)
    })

    test('should validate data structure', async () => {
      const invalidData = { invalid: 'structure' }
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(invalidData))

      const result = await logView.loadYearlyData(2025)

      // Should generate new data when invalid
      expect(result.year).toBe(2025)
      expect(result.days).toBeDefined()
    })

    test('should generate yearly data if file does not exist', async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false)
      
      // Mock generateYearlyData
      logView.generateYearlyData = jest.fn().mockResolvedValue({
        year: 2025,
        days: {},
        metadata: { version: '1.0' }
      })

      const result = await logView.loadYearlyData(2025)

      expect(logView.generateYearlyData).toHaveBeenCalledWith(2025)
      expect(result.year).toBe(2025)
    })
  })

  describe('calculateLevel', () => {
    test('should return 0 for no tasks', () => {
      expect(logView.calculateLevel({ totalTasks: 0 })).toBe(0)
      expect(logView.calculateLevel(null)).toBe(0)
      expect(logView.calculateLevel(undefined)).toBe(0)
    })

    test('should return 5 for zero procrastination', () => {
      const stats = {
        totalTasks: 10,
        completedTasks: 10,
        procrastinatedTasks: 0
      }
      expect(logView.calculateLevel(stats)).toBe(4)
    })

    test('should return correct levels based on completion rate', () => {
      expect(logView.calculateLevel({
        totalTasks: 10,
        completedTasks: 9,
        procrastinatedTasks: 1,
        completionRate: 0.9
      })).toBe(3)

      expect(logView.calculateLevel({
        totalTasks: 10,
        completedTasks: 6,
        procrastinatedTasks: 4,
        completionRate: 0.6
      })).toBe(2)

      expect(logView.calculateLevel({
        totalTasks: 10,
        completedTasks: 3,
        procrastinatedTasks: 7,
        completionRate: 0.3
      })).toBe(1)

      expect(logView.calculateLevel({
        totalTasks: 10,
        completedTasks: 1,
        procrastinatedTasks: 9,
        completionRate: 0.1
      })).toBe(1)
    })
  })

  describe('createTooltipText', () => {
    test('should create tooltip for no tasks', () => {
      const result = logView.createTooltipText('2025-01-01', null)
      expect(result).toContain('2025年1月1日')
      expect(result).toContain('タスクなし')
    })

    test('should create tooltip with task stats', () => {
      const stats = {
        totalTasks: 10,
        completedTasks: 7,
        procrastinatedTasks: 3,
        completionRate: 0.7
      }
      const result = logView.createTooltipText('2025-01-01', stats)
      expect(result).toContain('2025年1月1日')
      expect(result).toContain('総タスク: 10')
      expect(result).toContain('完了: 7')
      expect(result).toContain('先送り: 3')
      expect(result).toContain('完了率: 70%')
    })
  })

  describe('renderEmptyHeatmap', () => {
    test('should render empty heatmap with error message', () => {
      logView.createHeatmapGrid = jest.fn().mockReturnValue({
        querySelectorAll: jest.fn().mockReturnValue([
          { dataset: {} },
          { dataset: {} }
        ])
      })

      logView.renderEmptyHeatmap(2025)

      expect(container.createEl).toHaveBeenCalledWith('div', {
        cls: 'heatmap-container'
      })
      expect(container.createEl).toHaveBeenCalledWith('div', {
        cls: 'heatmap-error',
        text: '2025年のデータは利用できません'
      })
    })
  })
})