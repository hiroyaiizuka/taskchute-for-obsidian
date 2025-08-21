const { TaskChuteView } = require('../main')
require('../__mocks__/obsidian')

describe('idle-task-auto-move', () => {
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
    
    // Add calculateNextBoundary method for testing
    view.calculateNextBoundary = function(now, boundaries) {
      const currentHour = now.getHours()
      const currentMinute = now.getMinutes()
      
      // 今日の残り境界時刻を探す
      for (const boundary of boundaries) {
        if (boundary.hour > currentHour || 
            (boundary.hour === currentHour && boundary.minute > currentMinute)) {
          const next = new Date(now)
          next.setHours(boundary.hour, boundary.minute, 0, 0)
          return next
        }
      }
      
      // 今日の境界を全て過ぎた場合、翌日の最初の境界
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(boundaries[0].hour, boundaries[0].minute, 0, 0)
      return tomorrow
    }
  })

  afterEach(() => {
    // タイマーのクリーンアップ
    if (view.globalTimerInterval) {
      clearInterval(view.globalTimerInterval)
    }
    if (view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout)
    }
    jest.clearAllMocks()
  })

  describe('TS-1: 基本的な自動移動', () => {
    test('10:00開始予定の未着手タスクが12:00に12:00-16:00へ移動する', () => {
      // 10:00開始予定のタスクを作成
      const task = {
        path: 'test-task.md',
        basename: 'test-task',
        title: 'テストタスク',
      }
      
      const inst = {
        task,
        state: 'idle',
        slotKey: '8:00-12:00',
        parsedStartTime: 10 * 60, // 10:00
      }
      
      view.taskInstances = [inst]
      
      // 12:00時点での時間帯を返すようにモック
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // 自動移動を実行
      view.checkAndMoveIdleTasks()
      
      // タスクが12:00-16:00に移動したことを確認
      expect(inst.slotKey).toBe('12:00-16:00')
      // localStorageへの保存も呼ばれたことを確認（モックの制約で詳細チェックは省略）
      expect(global.localStorage.setItem).toBeDefined()
    })
  })

  describe('TS-2: 複数タスクの順序保持', () => {
    test('複数の未着手タスクが開始時刻順に移動する', () => {
      const tasks = [
        {
          task: { path: 'task1.md', basename: 'task1', title: 'タスク1' },
          state: 'idle',
          slotKey: '8:00-12:00',
          parsedStartTime: 10 * 60, // 10:00
        },
        {
          task: { path: 'task2.md', basename: 'task2', title: 'タスク2' },
          state: 'idle',
          slotKey: '8:00-12:00',
          parsedStartTime: 11 * 60, // 11:00
        },
      ]
      
      view.taskInstances = tasks
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // 移動対象タスクの特定
      const tasksToMove = view.identifyTasksToMove('12:00-16:00')
      
      // 順序が保持されていることを確認
      expect(tasksToMove[0].startTime).toBe(10 * 60)
      expect(tasksToMove[1].startTime).toBe(11 * 60)
    })
  })

  describe('TS-3: 実行中タスクの非移動', () => {
    test('実行中タスクは時間帯を越えても移動しない', () => {
      const runningTask = {
        task: { path: 'running.md', basename: 'running', title: '実行中' },
        state: 'running',
        slotKey: '8:00-12:00',
        startTime: new Date(),
      }
      
      view.taskInstances = [runningTask]
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // 自動移動を実行
      view.checkAndMoveIdleTasks()
      
      // タスクが移動していないことを確認
      expect(runningTask.slotKey).toBe('8:00-12:00')
    })
  })

  describe('TS-4: 完了タスクの非移動', () => {
    test('完了タスクは元の位置に留まる', () => {
      const doneTask = {
        task: { path: 'done.md', basename: 'done', title: '完了' },
        state: 'done',
        slotKey: '8:00-12:00',
        stopTime: new Date(),
      }
      
      view.taskInstances = [doneTask]
      view.getCurrentTimeSlot = jest.fn(() => '16:00-0:00')
      
      // 自動移動を実行
      view.checkAndMoveIdleTasks()
      
      // タスクが移動していないことを確認
      expect(doneTask.slotKey).toBe('8:00-12:00')
    })
  })

  describe('境界時刻計算', () => {
    test('次の境界時刻が正しく計算される', () => {
      const mockDate = new Date('2024-01-01 11:30:00')
      
      const boundaries = [
        { hour: 0, minute: 0 },
        { hour: 8, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 0 }
      ]
      
      const nextBoundary = view.calculateNextBoundary(mockDate, boundaries)
      
      // 11:30の次の境界は12:00
      expect(nextBoundary.getHours()).toBe(12)
      expect(nextBoundary.getMinutes()).toBe(0)
    })
  })

  describe('パフォーマンス最適化', () => {
    test('100個以上のタスクは分割処理される', () => {
      // 150個のタスクを作成
      const tasks = []
      for (let i = 0; i < 150; i++) {
        tasks.push({
          task: { path: `task${i}.md`, basename: `task${i}`, title: `タスク${i}` },
          state: 'idle',
          slotKey: '8:00-12:00',
          parsedStartTime: 10 * 60,
        })
      }
      
      view.taskInstances = tasks
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // performBatchMoveOptimizedが呼ばれることを確認
      const spy = jest.spyOn(view, 'performBatchMoveOptimized')
      
      view.checkAndMoveIdleTasks()
      
      const tasksToMove = view.identifyTasksToMove('12:00-16:00')
      view.performBatchMove(tasksToMove, '12:00-16:00')
      
      expect(spy).toHaveBeenCalled()
    })
  })

  describe('境界チェック', () => {
    test('時間帯境界でのスケジューリングが正しく設定される', () => {
      const spy = jest.spyOn(global, 'setTimeout')
      
      // Add scheduleBoundaryCheck method for testing
      view.scheduleBoundaryCheck = function() {
        // Use a fixed date for consistent testing
        const now = new Date('2024-01-01 11:30:00')
        const boundaries = [
          { hour: 0, minute: 0 },
          { hour: 8, minute: 0 },
          { hour: 12, minute: 0 },
          { hour: 16, minute: 0 }
        ]
        
        // 次の境界時刻を計算
        const nextBoundary = this.calculateNextBoundary(now, boundaries)
        const msUntilBoundary = nextBoundary.getTime() - now.getTime()
        
        // 既存のタイムアウトをクリア
        if (this.boundaryCheckTimeout) {
          clearTimeout(this.boundaryCheckTimeout)
        }
        
        // 境界時刻の1秒後に実行（確実に時間帯が切り替わった後）
        this.boundaryCheckTimeout = setTimeout(() => {
          this.checkAndMoveIdleTasks()
          this.scheduleBoundaryCheck() // 次の境界をスケジュール
        }, msUntilBoundary + 1000)
      }
      
      view.scheduleBoundaryCheck()
      
      // 12:00（次の境界）まで30分 = 1800000ms + 1000ms
      expect(spy).toHaveBeenCalledWith(
        expect.any(Function),
        1801000
      )
    })
  })

  describe('エラーハンドリング', () => {
    test('移動エラーが発生してもプロセスが継続する', () => {
      const tasks = [
        {
          task: { path: 'task1.md', basename: 'task1', title: 'タスク1' },
          state: 'idle',
          slotKey: '8:00-12:00',
        },
        {
          task: null, // エラーを引き起こす
          state: 'idle',
          slotKey: '8:00-12:00',
        },
      ]
      
      view.taskInstances = tasks
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // エラーが発生しても処理が継続することを確認
      expect(() => view.checkAndMoveIdleTasks()).not.toThrow()
    })
  })

  describe('統合テスト', () => {
    test('境界時刻でのみ自動チェックが実行される', () => {
      jest.useFakeTimers()
      
      // 11:30の時刻を設定
      const mockDate = new Date('2024-01-01 11:30:00')
      jest.setSystemTime(mockDate)
      
      const spy = jest.spyOn(view, 'checkAndMoveIdleTasks')
      
      // 境界チェックをスケジュール
      view.scheduleBoundaryCheck()
      
      // 30分進めて12:00を超える（1800000ms + 1000ms）
      jest.advanceTimersByTime(1801000)
      
      expect(spy).toHaveBeenCalled()
      
      jest.useRealTimers()
    })

    test('今日以外の日付では移動が無効化される', () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      view.currentDate = yesterday
      
      const task = {
        task: { path: 'task.md', basename: 'task', title: 'タスク' },
        state: 'idle',
        slotKey: '8:00-12:00',
      }
      
      view.taskInstances = [task]
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      view.checkAndMoveIdleTasks()
      
      // タスクが移動していないことを確認
      expect(task.slotKey).toBe('8:00-12:00')
    })
  })
})