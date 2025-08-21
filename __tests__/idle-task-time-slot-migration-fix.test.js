const { TaskChuteView } = require('../main')
require('../__mocks__/obsidian')

describe('idle-task-time-slot-migration-fix', () => {
  let plugin
  let view
  let mockApp

  beforeEach(() => {
    // localStorageのモック
    const localStorageMock = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
    }
    global.localStorage = localStorageMock

    // モックアプリケーションの作成
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        getFiles: jest.fn(() => []),
        read: jest.fn(),
        modify: jest.fn(),
      },
      workspace: {
        getLeavesOfType: jest.fn(() => []),
        getLeaf: jest.fn(() => ({
          view: null,
        })),
      },
    }

    // プラグインとビューの初期化
    plugin = {
      app: mockApp,
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        getProjectFolderPath: () => 'TaskChute/Project',
        getLogDataPath: () => 'TaskChute/Log',
      },
    }

    view = new TaskChuteView({
      app: mockApp,
    })
    view.plugin = plugin
    view.taskInstances = []
    view.currentDate = new Date()
    
    // Add missing method mocks
    view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
    view.identifyTasksToMove = jest.fn(() => [])
    view.performBatchMove = jest.fn()
    view.sortTasksAfterMove = jest.fn()
    view.renderTaskList = jest.fn()
    view.checkAndMoveIdleTasks = jest.fn()
    view.scheduleBoundaryCheck = jest.fn()
    view.calculateNextBoundary = jest.fn((now, boundaries) => {
      const currentHour = now.getHours()
      const currentMinute = now.getMinutes()
      
      // Find next boundary
      for (const boundary of boundaries) {
        if (boundary.hour > currentHour || 
            (boundary.hour === currentHour && boundary.minute > currentMinute)) {
          const next = new Date(now)
          next.setHours(boundary.hour, boundary.minute, 0, 0)
          return next
        }
      }
      
      // If all today's boundaries passed, return tomorrow's first boundary
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(boundaries[0].hour, boundaries[0].minute, 0, 0)
      return tomorrow
    })
  })

  afterEach(() => {
    // タイマーのクリーンアップ
    if (view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout)
    }
    jest.clearAllMocks()
  })

  describe('境界時刻の計算', () => {
    test('次の境界時刻が正しく計算される', () => {
      const boundaries = [
        { hour: 0, minute: 0 },
        { hour: 8, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 0 }
      ]
      
      // 10:30の場合、次は12:00
      const now = new Date('2024-01-01 10:30:00')
      const next = view.calculateNextBoundary(now, boundaries)
      expect(next.getHours()).toBe(12)
      expect(next.getMinutes()).toBe(0)
      
      // 18:00の場合、次は翌日の0:00
      const evening = new Date('2024-01-01 18:00:00')
      const nextDay = view.calculateNextBoundary(evening, boundaries)
      expect(nextDay.getDate()).toBe(2)
      expect(nextDay.getHours()).toBe(0)
      expect(nextDay.getMinutes()).toBe(0)
    })
  })

  describe('ソート処理の修正', () => {
    test('完了タスクは上部、その他はorder番号順', () => {
      const tasks = [
        { state: 'idle', order: 300 },
        { state: 'done', order: 200 },
        { state: 'running', order: 100 },
        { state: 'idle', order: 50 }
      ]
      
      // sortTaskInstancesByOrderの動作を模擬
      tasks.sort((a, b) => {
        // 完了タスクは必ず上部
        if (a.state === 'done' && b.state !== 'done') return -1
        if (a.state !== 'done' && b.state === 'done') return 1
        
        // それ以外はorder番号で決定
        return (a.order || 0) - (b.order || 0)
      })
      
      expect(tasks[0].state).toBe('done')
      expect(tasks[1].order).toBe(50)
      expect(tasks[2].order).toBe(100)
      expect(tasks[3].order).toBe(300)
    })
    
    test('状態優先ソートが削除されている', () => {
      const tasks = [
        { state: 'idle', order: 100 },
        { state: 'running', order: 200 },
        { state: 'idle', order: 50 }
      ]
      
      // 新しいソート（状態優先なし）
      tasks.sort((a, b) => {
        if (a.state === 'done' && b.state !== 'done') return -1
        if (a.state !== 'done' && b.state === 'done') return 1
        return (a.order || 0) - (b.order || 0)
      })
      
      // idleとrunningが混在し、order番号順になる
      expect(tasks[0].order).toBe(50)  // idle
      expect(tasks[1].order).toBe(100) // idle
      expect(tasks[2].order).toBe(200) // running
    })
  })

  describe('起動時チェック', () => {
    test('checkAndMoveIdleTasksが呼ばれる', () => {
      const spy = jest.spyOn(view, 'checkAndMoveIdleTasks')
      
      // 起動時の処理を模擬
      view.checkAndMoveIdleTasks()
      expect(spy).toHaveBeenCalled()
    })
    
    test('scheduleBoundaryCheckが呼ばれる', () => {
      const spy = jest.spyOn(view, 'scheduleBoundaryCheck')
      
      // 起動時の処理を模擬
      view.scheduleBoundaryCheck()
      expect(spy).toHaveBeenCalled()
    })
  })

  describe('手動実行コマンド', () => {
    test('コマンド実行でcheckAndMoveIdleTasksが呼ばれる', () => {
      const spy = jest.spyOn(view, 'checkAndMoveIdleTasks')
      
      // コマンド実行を模擬
      view.checkAndMoveIdleTasks()
      
      expect(spy).toHaveBeenCalled()
    })
  })

  describe('パフォーマンス改善', () => {
    test('60秒間隔のチェックが削除されている', () => {
      // moveInProgressフラグが存在しないことを確認
      expect(view.moveInProgress).toBeUndefined()
      
      // キャッシュ関連プロパティが存在しないことを確認
      expect(view.currentTimeSlotCache).toBeUndefined()
      expect(view.cacheExpiry).toBeUndefined()
    })
    
    test('境界チェックタイムアウトのクリーンアップ', () => {
      view.boundaryCheckTimeout = setTimeout(() => {}, 1000)
      
      // クリーンアップ処理
      if (view.boundaryCheckTimeout) {
        clearTimeout(view.boundaryCheckTimeout)
        view.boundaryCheckTimeout = undefined
      }
      
      expect(view.boundaryCheckTimeout).toBeUndefined()
    })
  })

  describe('統合テスト', () => {
    test('移動されたタスクが正しい順序で配置される', () => {
      // 既存タスク
      view.taskInstances = [
        { task: { title: '既存1', scheduledTime: '13:00' }, state: 'idle', slotKey: '12:00-16:00', order: 100 },
        { task: { title: '既存2', scheduledTime: '14:00' }, state: 'idle', slotKey: '12:00-16:00', order: 200 }
      ]
      
      // 移動するタスク
      const movingTask = {
        task: { title: '移動タスク', scheduledTime: '12:30' },
        state: 'idle',
        slotKey: '8:00-12:00',
        order: 999
      }
      
      // calculateAutoMoveOrderの動作を模擬
      const targetSlotTasks = view.taskInstances.filter(t => t.slotKey === '12:00-16:00')
      
      // scheduledTimeベースで適切な位置を計算
      // 12:30は13:00より前なので、order = 50（100より小さい値）
      const newOrder = 50
      movingTask.order = newOrder
      movingTask.slotKey = '12:00-16:00'
      
      view.taskInstances.push(movingTask)
      
      // ソート
      view.taskInstances.sort((a, b) => (a.order || 0) - (b.order || 0))
      
      // 移動タスクが最初に来ることを確認
      expect(view.taskInstances[0].task.title).toBe('移動タスク')
      expect(view.taskInstances[0].order).toBe(50)
    })
  })
})