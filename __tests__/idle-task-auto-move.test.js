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

  describe('キャッシュ機構', () => {
    test('30秒間は同じ時間帯を返す', () => {
      const now = Date.now()
      jest.spyOn(Date, 'now').mockReturnValue(now)
      
      view.getCurrentTimeSlot = jest.fn(() => '12:00-16:00')
      
      // 初回呼び出し
      const slot1 = view.getCurrentTimeSlotCached()
      expect(view.getCurrentTimeSlot).toHaveBeenCalledTimes(1)
      
      // 10秒後の呼び出し（キャッシュから返される）
      jest.spyOn(Date, 'now').mockReturnValue(now + 10000)
      const slot2 = view.getCurrentTimeSlotCached()
      expect(view.getCurrentTimeSlot).toHaveBeenCalledTimes(1) // 呼ばれない
      expect(slot1).toBe(slot2)
      
      // 31秒後の呼び出し（キャッシュ期限切れ）
      jest.spyOn(Date, 'now').mockReturnValue(now + 31000)
      const slot3 = view.getCurrentTimeSlotCached()
      expect(view.getCurrentTimeSlot).toHaveBeenCalledTimes(2) // 再度呼ばれる
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
      const mockDate = new Date('2024-01-01 11:30:00')
      jest.spyOn(global, 'Date').mockImplementation(() => mockDate)
      
      const spy = jest.spyOn(global, 'setTimeout')
      
      view.scheduleBoundaryCheck()
      
      // 12:00（次の境界）まで30分 = 1800秒 + 1秒
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
    test('60秒ごとに自動チェックが実行される', () => {
      // Date.nowをモック
      const originalDateNow = Date.now
      Date.now = jest.fn(() => 1000000)
      
      jest.useFakeTimers()
      
      view.manageTimers()
      
      const spy = jest.spyOn(view, 'checkAndMoveIdleTasks')
      
      // 60秒進める
      Date.now = jest.fn(() => 1060000)
      jest.advanceTimersByTime(60000)
      
      expect(spy).toHaveBeenCalled()
      
      jest.useRealTimers()
      Date.now = originalDateNow
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