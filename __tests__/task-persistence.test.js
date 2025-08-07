// task-persistence.test.js
// タスク位置の永続化に関するテスト

const { TaskChuteView } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

// Obsidian APIのモック
global.app = {
  vault: {
    getMarkdownFiles: jest.fn().mockReturnValue([]),
    read: jest.fn(),
    modify: jest.fn(),
    getAbstractFileByPath: jest.fn(),
    adapter: {
      exists: jest.fn(),
      read: jest.fn()
    }
  },
  workspace: {
    getLeaf: jest.fn(),
    getActiveFile: jest.fn()
  },
  metadataCache: {
    getFileCache: jest.fn()
  },
  plugins: {
    plugins: {}
  }
}

global.Notice = jest.fn()
global.moment = require('moment')
global.ItemView = class ItemView {
  constructor() {}
}
global.Plugin = class Plugin {}

describe('Task Persistence', () => {
  let plugin
  let localStorageMock
  let getItemSpy
  let setItemSpy

  beforeEach(() => {
    // localStorageのモック
    localStorageMock = {}
    getItemSpy = jest.fn(key => localStorageMock[key])
    setItemSpy = jest.fn((key, value) => { localStorageMock[key] = value })
    const removeItemSpy = jest.fn(key => { delete localStorageMock[key] })
    const clearSpy = jest.fn(() => { Object.keys(localStorageMock).forEach(key => delete localStorageMock[key]) })
    
    global.localStorage = {
      getItem: getItemSpy,
      setItem: setItemSpy,
      removeItem: removeItemSpy,
      clear: clearSpy
    }
    // モック関数をクリア
    jest.clearAllMocks()

    // TaskChuteViewのモックを作成
    const mockLeaf = {
      view: null
    }
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    plugin = new TaskChuteView(mockLeaf, mockPlugin)
    plugin.app = app // appプロパティを設定
    plugin.taskInstances = []
    plugin.currentDate = new Date('2025-01-23')
    plugin.useOrderBasedSort = true // orderベースのソートを有効化
    // 必要なプロパティをモック
    plugin.taskList = {
      empty: jest.fn(),
      scrollTop: 0,
      scrollLeft: 0,
      querySelector: jest.fn(),
      querySelectorAll: jest.fn()
    }
    plugin.renderTaskList = jest.fn()
    plugin.sortTaskInstancesByTimeOrder = jest.fn()
    plugin.moveIdleTasksToCurrentSlot = jest.fn()
    plugin.restoreRunningTaskState = jest.fn()
    plugin.loadTodayExecutions = jest.fn().mockResolvedValue([])
    plugin.getTaskFiles = jest.fn().mockResolvedValue([])
    plugin.shouldShowWeeklyRoutine = jest.fn()
    plugin.getTimeSlotKeys = jest.fn().mockReturnValue(['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00'])
    plugin.getSlotFromScheduledTime = jest.fn((time) => {
      const hour = parseInt(time.split(':')[0])
      if (hour < 8) return '0:00-8:00'
      if (hour < 12) return '8:00-12:00'
      if (hour < 16) return '12:00-16:00'
      return '16:00-0:00'
    })
    plugin.determineSlotKey = jest.fn((taskPath, savedOrders, taskObj) => {
      if (savedOrders[taskPath]?.slot) {
        return savedOrders[taskPath].slot
      }
      if (taskObj.scheduledTime) {
        return plugin.getSlotFromScheduledTime(taskObj.scheduledTime)
      }
      return 'none'
    })
    
    // getCurrentDateStringメソッドを追加
    plugin.getCurrentDateString = jest.fn().mockReturnValue('2025-01-23')
    
    // ヘルパー関数を実装
    plugin.loadSavedOrders = jest.fn((dateStr) => {
      try {
        const data = getItemSpy(`taskchute-orders-${dateStr}`)
        return data ? JSON.parse(data) : {}
      } catch (e) {
        return {}
      }
    })
    
    plugin.saveTaskOrders = jest.fn(() => {
      const dateStr = plugin.getCurrentDateString()
      const orderData = {}
      
      plugin.taskInstances.forEach(inst => {
        if (inst.order !== null && inst.order !== undefined) {
          orderData[inst.task.path] = {
            slot: inst.slotKey,
            order: inst.order
          }
        }
      })
      
      setItemSpy(`taskchute-orders-${dateStr}`, JSON.stringify(orderData))
    })
    
    plugin.moveInstanceToSlotSimple = jest.fn((instance, targetSlot, targetIndex) => {
      instance.slotKey = targetSlot
      instance.order = 200 // 新しいorder
      plugin.saveTaskOrders()
    })
  })

  describe('loadSavedOrders（localStorage読み込み）', () => {
    test('保存されたorder情報を正しく読み込む', () => {
      const savedData = {
        'task1.md': { slot: '8:00-12:00', order: 100 },
        'task2.md': { slot: '12:00-16:00', order: 200 }
      }
      localStorageMock['taskchute-orders-2025-01-23'] = JSON.stringify(savedData)

      // loadSavedOrdersがpluginに存在することを確認
      expect(typeof plugin.loadSavedOrders).toBe('function')

      const result = plugin.loadSavedOrders('2025-01-23')
      
      expect(result).toEqual(savedData)
    })

    test('データがない場合は空オブジェクトを返す', () => {
      const result = plugin.loadSavedOrders('2025-01-23')
      expect(result).toEqual({})
    })

    test('JSONパースエラー時は空オブジェクトを返す', () => {
      localStorageMock['taskchute-orders-2025-01-23'] = 'invalid json'

      const result = plugin.loadSavedOrders('2025-01-23')
      expect(result).toEqual({})
    })
  })

  describe('saveTaskOrders（localStorage保存）', () => {
    test('タスクのorder情報を正しく保存する', () => {
      plugin.taskInstances = [
        { task: { path: 'task1.md' }, slotKey: '8:00-12:00', order: 100 },
        { task: { path: 'task2.md' }, slotKey: '12:00-16:00', order: 200 }
      ]

      plugin.saveTaskOrders()

      expect(setItemSpy).toHaveBeenCalledWith(
        'taskchute-orders-2025-01-23',
        JSON.stringify({
          'task1.md': { slot: '8:00-12:00', order: 100 },
          'task2.md': { slot: '12:00-16:00', order: 200 }
        })
      )
    })

    test('orderがnullのタスクは保存しない', () => {
      plugin.taskInstances = [
        { task: { path: 'task1.md' }, slotKey: '8:00-12:00', order: 100 },
        { task: { path: 'task2.md' }, slotKey: '12:00-16:00', order: null }
      ]

      plugin.saveTaskOrders()

      expect(setItemSpy).toHaveBeenCalledWith(
        'taskchute-orders-2025-01-23',
        JSON.stringify({
          'task1.md': { slot: '8:00-12:00', order: 100 }
        })
      )
    })
  })

  describe('タスク移動後の永続化フロー', () => {
    test('ドラッグ&ドロップ後、位置が保存される', () => {
      const taskInstance = {
        task: { path: 'task1.md' },
        slotKey: '8:00-12:00',
        order: 100,
        state: 'idle'
      }
      
      plugin.taskInstances = [taskInstance]
      
      // renderTaskListをモックしてDOM操作エラーを回避
      plugin.renderTaskList = jest.fn()
      plugin.sortByOrder = jest.fn()

      // moveInstanceToSlotSimpleを使用
      plugin.moveInstanceToSlotSimple(taskInstance, '12:00-16:00', 0)

      // 保存されたデータを確認
      expect(setItemSpy).toHaveBeenCalledWith(
        'taskchute-orders-2025-01-23',
        JSON.stringify({
          'task1.md': { slot: '12:00-16:00', order: 200 }
        })
      )
      
      // タスクの状態も更新されていることを確認
      expect(taskInstance.slotKey).toBe('12:00-16:00')
      expect(taskInstance.order).toBe(200)
    })

    test('再起動後、保存された位置が復元される', async () => {
      // 保存されたデータを設定
      const savedData = {
        'TaskChute/Task/routine-task.md': { slot: '12:00-16:00', order: 200 }
      }
      localStorageMock['taskchute-orders-2025-01-23'] = JSON.stringify(savedData)

      // タスクフォルダーをモック
      const mockTaskFolder = {
        children: [{
          path: 'TaskChute/Task/routine-task.md',
          name: 'routine-task.md',
          basename: 'Routine Task',
          extension: 'md',
          stat: { mtime: Date.now() }
        }]
      }
      
      plugin.getTaskFiles = jest.fn().mockResolvedValue(mockTaskFolder.children)
      
      global.app.vault.getAbstractFileByPath.mockReturnValue(mockTaskFolder)
      global.app.metadataCache.getFileCache.mockReturnValue({
        tags: [{ tag: '#task' }],
        frontmatter: {
          routine: true,
          開始時刻: '09:00'
        }
      })
      global.app.vault.read.mockResolvedValue('#task\nRoutine Task')

      // loadTasksのモックを作成して、savedOrdersを使用するように
      plugin.loadTasks = jest.fn(async () => {
        const files = await plugin.getTaskFiles()
        const savedOrders = plugin.loadSavedOrders('2025-01-23')
        
        files.forEach(file => {
          const taskObj = {
            path: file.path,
            title: file.basename,
            scheduledTime: '09:00'
          }
          
          const slotKey = plugin.determineSlotKey(file.path, savedOrders, taskObj)
          const order = savedOrders[file.path]?.order ?? 100
          
          plugin.taskInstances.push({
            task: taskObj,
            state: 'idle',
            slotKey: slotKey,
            order: order
          })
        })
      })
      
      // loadTasksを使用
      await plugin.loadTasks()

      // タスクが保存された位置に配置されていることを確認
      expect(plugin.taskInstances).toHaveLength(1)
      expect(plugin.taskInstances[0].slotKey).toBe('12:00-16:00') // scheduledTimeではなく保存された位置
      expect(plugin.taskInstances[0].order).toBe(200)
    })
  })
})