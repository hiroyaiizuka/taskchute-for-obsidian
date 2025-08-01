const { TaskChuteView, TaskChutePlugin } = require('../main.js')
const { mockApp } = require('../__mocks__/obsidian')

describe('Cross-day task duration calculation', () => {
  let plugin
  let view
  let app

  beforeEach(() => {
    app = mockApp
    plugin = new TaskChutePlugin()
    plugin.app = app
    plugin.settings = {
      completionEffects: false
    }
    
    const mockLeaf = {
      view: {},
      getViewState: () => ({}),
      setViewState: jest.fn(),
    }
    
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = app
    view.plugin = mockPlugin
  })

  describe('calculateCrossDayDuration', () => {
    test('22:00 to 02:00 should be 4 hours', () => {
      const start = new Date('2024-01-01T22:00:00')
      const stop = new Date('2024-01-02T02:00:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(4 * 60 * 60 * 1000)
    })

    test('23:00 to 01:00 should be 2 hours', () => {
      const start = new Date('2024-01-01T23:00:00')
      const stop = new Date('2024-01-02T01:00:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(2 * 60 * 60 * 1000)
    })

    test('23:59 to 00:01 should be 2 minutes', () => {
      const start = new Date('2024-01-01T23:59:00')
      const stop = new Date('2024-01-02T00:01:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(2 * 60 * 1000)
    })

    test('00:00 to 00:00 with day change should be 24 hours', () => {
      const start = new Date('2024-01-01T00:00:00')
      const stop = new Date('2024-01-02T00:00:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(24 * 60 * 60 * 1000)
    })

    test('normal task within same day should calculate correctly', () => {
      const start = new Date('2024-01-01T10:00:00')
      const stop = new Date('2024-01-01T14:00:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(4 * 60 * 60 * 1000)
    })

    test('should handle null inputs gracefully', () => {
      expect(view.calculateCrossDayDuration(null, null)).toBe(0)
      expect(view.calculateCrossDayDuration(new Date(), null)).toBe(0)
      expect(view.calculateCrossDayDuration(null, new Date())).toBe(0)
    })

    test('task over 24 hours should calculate correctly', () => {
      const start = new Date('2024-01-01T10:00:00')
      const stop = new Date('2024-01-02T12:00:00')
      const duration = view.calculateCrossDayDuration(start, stop)
      expect(duration).toBe(26 * 60 * 60 * 1000)
    })
  })

  describe('Task date assignment', () => {
    test('cross-day task should be saved with start date', async () => {
      const inst = {
        task: { 
          title: 'Test Task',
          path: 'TaskChute/Task/TestTask.md',
          isRoutine: false,
          projectTitle: null
        },
        state: 'done',
        startTime: new Date('2024-01-01T22:00:00'),
        stopTime: new Date('2024-01-02T02:00:00'),
        slotKey: 'night'
      }

      // Mock the vault adapter
      view.app.vault.adapter.exists = jest.fn().mockResolvedValue(false)
      view.app.vault.adapter.mkdir = jest.fn().mockResolvedValue()
      view.app.vault.adapter.write = jest.fn().mockResolvedValue()

      await view.saveTaskCompletion(inst, {
        executionComment: '',
        focusLevel: 0,
        energyLevel: 0
      })

      // Verify the task was saved with the start date (2024-01-01)
      expect(view.app.vault.adapter.write).toHaveBeenCalledWith(
        expect.stringContaining('2024-01-tasks.json'),
        expect.any(String)
      )

      const writtenContent = JSON.parse(view.app.vault.adapter.write.mock.calls[0][1])
      expect(writtenContent.taskExecutions['2024-01-01']).toBeDefined()
      expect(writtenContent.taskExecutions['2024-01-02']).toBeUndefined()
    })
  })

  describe('Display format', () => {
    test('cross-day task should display positive duration', () => {
      const taskItem = document.createElement('div')
      const inst = {
        task: { title: 'Test Task' },
        state: 'done',
        startTime: new Date('2024-01-01T22:00:00'),
        stopTime: new Date('2024-01-02T02:00:00')
      }

      // Mock createEl to capture the created elements
      const createdElements = []
      taskItem.createEl = jest.fn((tag, options) => {
        const el = document.createElement(tag)
        if (options.cls) el.className = options.cls
        if (options.text) el.textContent = options.text
        if (options.attr && options.attr.title) el.title = options.attr.title
        createdElements.push({ tag, options, el })
        taskItem.appendChild(el)
        
        // setAttribute メソッドを追加
        el.setAttribute = jest.fn((attr, value) => {
          if (attr === 'title') el.title = value
        })
        
        return el
      })

      // Simulate the duration display logic
      const duration = view.calculateCrossDayDuration(inst.startTime, inst.stopTime)
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      const durationStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
      
      const isCrossDay = inst.stopTime.getDate() !== inst.startTime.getDate()
      
      const durationEl = taskItem.createEl('span', {
        cls: isCrossDay ? 'task-duration cross-day' : 'task-duration',
        text: durationStr
      })
      
      if (isCrossDay) {
        durationEl.setAttribute('title', '日を跨いだタスク')
      }

      // Verify the duration is displayed as 04:00
      expect(durationStr).toBe('04:00')
      expect(durationEl.className).toContain('cross-day')
      expect(durationEl.title).toBe('日を跨いだタスク')
    })
  })
})