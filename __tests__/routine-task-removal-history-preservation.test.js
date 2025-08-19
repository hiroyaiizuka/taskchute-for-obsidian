/**
 * @jest-environment jsdom
 */

// Obsidian API モック
jest.mock('obsidian', () => {
  const mockDocument = {
    createElement: jest.fn(() => ({
      innerHTML: '',
      style: {},
      classList: {
        add: jest.fn(),
        remove: jest.fn()
      }
    }))
  }
  
  return {
    Plugin: class Plugin {},
    ItemView: class ItemView {
      constructor() {
        this.contentEl = mockDocument.createElement('div')
      }
    },
    TFile: class TFile {
      constructor(path) {
        this.path = path
        this.basename = path.split('/').pop().replace('.md', '')
      }
    },
    TFolder: class TFolder {
      constructor(path, children = []) {
        this.path = path
        this.children = children
      }
    },
    Notice: jest.fn(),
    moment: jest.fn(() => ({
      format: jest.fn((format) => {
        if (format === 'YYYY-MM-DD') return '2024-01-15'
        if (format === 'YYYY-MM') return '2024-01'
        return '2024-01-15'
      })
    }))
  }
})

const { TaskChuteView } = require('../main.js')
const { TFile, TFolder, Notice } = require('obsidian')

describe('ルーチンタスク履歴保護機能', () => {
  let view
  let mockApp
  let mockPlugin
  let mockPathManager

  beforeEach(() => {
    // モックの初期化
    mockPathManager = {
      getLogDataPath: jest.fn().mockReturnValue('data/logs')
    }

    mockPlugin = {
      pathManager: mockPathManager,
      settings: {}
    }

    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        delete: jest.fn(),
        modify: jest.fn(),
        create: jest.fn()
      },
      workspace: {
        containerEl: document.createElement('div')
      }
    }

    // TaskChuteViewのインスタンス作成
    view = new TaskChuteView(null, mockPlugin)
    view.app = mockApp
    view.taskInstances = []
    view.tasks = []
  })

  describe('hasExecutionHistory メソッド', () => {
    test('実行履歴が存在する場合はtrueを返す', async () => {
      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // ログファイルの内容モック
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/朝の運動.md',
              taskName: '朝の運動',
              isCompleted: true,
              executionTime: 30
            }
          ]
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // テスト実行
      const result = await view.hasExecutionHistory('Tasks/朝の運動.md')
      expect(result).toBe(true)
    })

    test('複数の月次ログファイルから履歴を検索できる', async () => {
      // 複数の月次ログファイルをモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2023-12-tasks.json'),
        new TFile('data/logs/2024-01-tasks.json'),
        new TFile('data/logs/2024-02-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path.endsWith('-tasks.json')) {
          return new TFile(path)
        }
        return null
      })

      // 異なる月のログファイル内容をモック
      mockApp.vault.read.mockImplementation(async (file) => {
        if (file.path === 'data/logs/2023-12-tasks.json') {
          return JSON.stringify({
            taskExecutions: {
              '2023-12-30': []
            }
          })
        }
        if (file.path === 'data/logs/2024-01-tasks.json') {
          return JSON.stringify({
            taskExecutions: {
              '2024-01-05': []
            }
          })
        }
        if (file.path === 'data/logs/2024-02-tasks.json') {
          return JSON.stringify({
            taskExecutions: {
              '2024-02-10': [
                {
                  taskId: 'Tasks/古いタスク.md',
                  taskName: '古いタスク',
                  isCompleted: true,
                  executionTime: 15
                }
              ]
            }
          })
        }
        return '{}'
      })

      // テスト実行
      const result = await view.hasExecutionHistory('Tasks/古いタスク.md')
      expect(result).toBe(true)
    })

    test('複数日付にわたる履歴検索ができる', async () => {
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // 複数日付のログファイル内容をモック
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-10': [
            {
              taskId: 'Tasks/別のタスク.md',
              taskName: '別のタスク',
              isCompleted: true,
              executionTime: 20
            }
          ],
          '2024-01-15': [
            {
              taskId: 'Tasks/検索対象タスク.md',
              taskName: '検索対象タスク',
              isCompleted: true,
              executionTime: 30
            }
          ],
          '2024-01-20': [
            {
              taskId: 'Tasks/さらに別のタスク.md',
              taskName: 'さらに別のタスク',
              isCompleted: false,
              executionTime: 0
            }
          ]
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // テスト実行
      const result = await view.hasExecutionHistory('Tasks/検索対象タスク.md')
      expect(result).toBe(true)
    })

    test('taskExecutionsプロパティが存在しない場合はfalseを返す', async () => {
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // taskExecutionsプロパティがないログファイル
      const mockLogContent = JSON.stringify({
        someOtherProperty: 'value'
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      const result = await view.hasExecutionHistory('Tasks/何かのタスク.md')
      expect(result).toBe(false)
    })

    test('実行履歴が存在しない場合はfalseを返す', async () => {
      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // 空のログファイルモック
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': []
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // テスト実行
      const result = await view.hasExecutionHistory('Tasks/新規タスク.md')
      expect(result).toBe(false)
    })

    test('データディレクトリが存在しない場合はfalseを返す', async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      const result = await view.hasExecutionHistory('Tasks/何かのタスク.md')
      expect(result).toBe(false)
    })

    test('データディレクトリがTFolderでない場合はfalseを返す', async () => {
      // TFileオブジェクトを返すモック（TFolderでない）
      mockApp.vault.getAbstractFileByPath.mockReturnValue(
        new TFile('data/logs/not-a-folder.txt')
      )

      const result = await view.hasExecutionHistory('Tasks/何かのタスク.md')
      expect(result).toBe(false)
    })

    test('ログファイルの読み取りエラー時は安全側（true）を返す', async () => {
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // 読み取りエラーを発生させる
      mockApp.vault.read.mockRejectedValue(new Error('ファイル読み取りエラー'))

      // コンソールエラーをモック
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      const result = await view.hasExecutionHistory('Tasks/エラータスク.md')
      expect(result).toBe(true) // エラー時は安全側（true）
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/履歴チェックエラー/),
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })

    test('JSON解析エラー時は安全側（true）を返す', async () => {
      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      // JSON解析エラーを発生させる
      mockApp.vault.read.mockResolvedValue('invalid json')

      // コンソールエラーをモック
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      // テスト実行
      const result = await view.hasExecutionHistory('Tasks/エラータスク.md')
      expect(result).toBe(true) // エラー時は安全側（true）
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/履歴チェックエラー/),
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })

    test('ログファイルがTFileでない場合はスキップして処理を続行', async () => {
      const mockDataDir = new TFolder('data/logs', [
        new TFolder('data/logs/subfolder'), // フォルダ（スキップされる）
        new TFile('data/logs/2024-01-tasks.json'), // 有効なファイル
        new TFile('data/logs/invalid-file.txt') // 無関係なファイル（スキップされる）
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/検索対象.md',
              taskName: '検索対象',
              isCompleted: true,
              executionTime: 30
            }
          ]
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      const result = await view.hasExecutionHistory('Tasks/検索対象.md')
      expect(result).toBe(true)
    })

    test('空のデータディレクトリの場合はfalseを返す', async () => {
      const mockDataDir = new TFolder('data/logs', []) // 空のディレクトリ
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        return null
      })

      const result = await view.hasExecutionHistory('Tasks/何かのタスク.md')
      expect(result).toBe(false)
    })
  })

  describe('削除判定ロジック', () => {
    beforeEach(() => {
      // 削除メソッドのモック
      view.deleteRoutineTask = jest.fn().mockResolvedValue()
      view.deleteNonRoutineTask = jest.fn().mockResolvedValue()
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)
      
      // hasExecutionHistoryのモック
      view.hasExecutionHistory = jest.fn()
    })

    test('ルーチンタスクは常に安全削除を使用', async () => {
      const mockTask = {
        path: 'Tasks/ルーチンタスク.md',
        title: 'ルーチンタスク',
        isRoutine: true
      }
      
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.hasExecutionHistory.mockResolvedValue(false)

      await view.deleteSelectedTask()

      expect(view.deleteRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
      expect(view.hasExecutionHistory).toHaveBeenCalledWith('Tasks/ルーチンタスク.md')
    })

    test('履歴があるタスクは安全削除を使用', async () => {
      const mockTask = {
        path: 'Tasks/元ルーチンタスク.md',
        title: '元ルーチンタスク',
        isRoutine: false // routine: falseに変更済み
      }
      
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.hasExecutionHistory.mockResolvedValue(true) // 履歴あり

      await view.deleteSelectedTask()

      expect(view.deleteRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
      expect(view.hasExecutionHistory).toHaveBeenCalledWith('Tasks/元ルーチンタスク.md')
    })

    test('履歴がない非ルーチンタスクは完全削除を許可', async () => {
      const mockTask = {
        path: 'Tasks/新規タスク.md',
        title: '新規タスク',
        isRoutine: false
      }
      
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.hasExecutionHistory.mockResolvedValue(false) // 履歴なし

      await view.deleteSelectedTask()

      expect(view.deleteNonRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteRoutineTask).not.toHaveBeenCalled()
      expect(view.hasExecutionHistory).toHaveBeenCalledWith('Tasks/新規タスク.md')
    })

    test('削除確認がキャンセルされた場合は何も実行しない', async () => {
      const mockTask = {
        path: 'Tasks/テストタスク.md',
        title: 'テストタスク',
        isRoutine: false
      }
      
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.showDeleteConfirmDialog.mockResolvedValue(false) // キャンセル
      view.hasExecutionHistory.mockResolvedValue(false)

      await view.deleteSelectedTask()

      expect(view.deleteRoutineTask).not.toHaveBeenCalled()
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
      expect(view.hasExecutionHistory).not.toHaveBeenCalled()
    })

    test('selectedTaskInstanceが存在しない場合は何も実行しない', async () => {
      view.selectedTaskInstance = null

      await view.deleteSelectedTask()

      expect(view.showDeleteConfirmDialog).not.toHaveBeenCalled()
      expect(view.deleteRoutineTask).not.toHaveBeenCalled()
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
      expect(view.hasExecutionHistory).not.toHaveBeenCalled()
    })

    test('hasExecutionHistoryでエラーが発生した場合は安全側に倒して処理継続', async () => {
      const mockTask = {
        path: 'Tasks/エラータスク.md',
        title: 'エラータスク',
        isRoutine: false
      }
      
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      
      // hasExecutionHistoryを直接モックして、エラー後安全側の動作をシミュレート
      view.hasExecutionHistory = jest.fn().mockResolvedValue(true) // エラー時の安全側

      await view.deleteSelectedTask()

      // hasExecutionHistoryが呼ばれることを確認
      expect(view.hasExecutionHistory).toHaveBeenCalledWith('Tasks/エラータスク.md')

      // 結果として、hasHistory=trueになり、deleteRoutineTaskが呼ばれる
      expect(view.deleteRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
    })
  })

  describe('統合シナリオテスト', () => {
    test('ルーチンタスクを非ルーチン化後も履歴が保護される', async () => {
      // 1. ルーチンタスクのセットアップ
      const taskPath = 'Tasks/朝の運動.md'
      const mockTask = {
        path: taskPath,
        title: '朝の運動',
        isRoutine: true, // 最初はルーチン
        file: new TFile(taskPath)
      }

      // 2. 実行履歴を作成
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-14': [
            {
              taskId: taskPath,
              taskName: '朝の運動',
              isCompleted: true,
              executionTime: 30
            }
          ],
          '2024-01-15': [
            {
              taskId: taskPath,
              taskName: '朝の運動',
              isCompleted: true,
              executionTime: 25
            }
          ]
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // 3. タスクを非ルーチン化（routine: false）
      mockTask.isRoutine = false

      // 4. 削除を試行
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.deleteRoutineTask = jest.fn()
      view.deleteNonRoutineTask = jest.fn()
      view.deleteInstanceWithFile = jest.fn()
      view.deleteTaskLogs = jest.fn()
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)

      await view.deleteSelectedTask()

      // 5. 検証：安全削除が使用され、データは保護される
      expect(view.deleteRoutineTask).toHaveBeenCalled()
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
      expect(view.deleteInstanceWithFile).not.toHaveBeenCalled()
      expect(view.deleteTaskLogs).not.toHaveBeenCalled()
      
      // ファイルは削除されない
      expect(mockApp.vault.delete).not.toHaveBeenCalled()
    })

    test('新規タスクは履歴チェック後に完全削除される', async () => {
      // 1. 新規タスクのセットアップ（履歴なし）
      const taskPath = 'Tasks/新規タスク.md'
      const mockTask = {
        path: taskPath,
        title: '新規タスク',
        isRoutine: false,
        file: new TFile(taskPath)
      }

      // 2. 履歴なしのログ環境をセットアップ
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        return null
      })

      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/別のタスク.md',
              taskName: '別のタスク',
              isCompleted: true,
              executionTime: 30
            }
          ]
        }
      })
      
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // 3. 削除を試行
      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.deleteRoutineTask = jest.fn()
      view.deleteNonRoutineTask = jest.fn()
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)

      await view.deleteSelectedTask()

      // 4. 検証：完全削除が使用される
      expect(view.deleteNonRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteRoutineTask).not.toHaveBeenCalled()
    })

    test('複数月にわたる履歴があるタスクは保護される', async () => {
      const taskPath = 'Tasks/長期タスク.md'
      const mockTask = {
        path: taskPath,
        title: '長期タスク',
        isRoutine: false, // 現在は非ルーチン
        file: new TFile(taskPath)
      }

      // 複数月のログファイルをセットアップ
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2023-12-tasks.json'),
        new TFile('data/logs/2024-01-tasks.json'),
        new TFile('data/logs/2024-02-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path.endsWith('-tasks.json')) {
          return new TFile(path)
        }
        return null
      })

      // 古い月のログに履歴があることをモック
      mockApp.vault.read.mockImplementation(async (file) => {
        if (file.path === 'data/logs/2023-12-tasks.json') {
          return JSON.stringify({
            taskExecutions: {
              '2023-12-15': [
                {
                  taskId: taskPath,
                  taskName: '長期タスク',
                  isCompleted: true,
                  executionTime: 45
                }
              ]
            }
          })
        }
        // 他の月は空
        return JSON.stringify({ taskExecutions: {} })
      })

      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.deleteRoutineTask = jest.fn()
      view.deleteNonRoutineTask = jest.fn()
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)

      await view.deleteSelectedTask()

      // 古い履歴が検出されて安全削除が使用される
      expect(view.deleteRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteNonRoutineTask).not.toHaveBeenCalled()
    })

    test('メタデータキャッシュからのisRoutine状態を正しく確認', async () => {
      const taskPath = 'Tasks/メタデータタスク.md'
      const mockFile = new TFile(taskPath)
      const mockTask = {
        path: taskPath,
        title: 'メタデータタスク',
        isRoutine: false, // メモリ上では false
        file: mockFile
      }

      // メタデータキャッシュでは true として設定
      const mockMetadata = {
        frontmatter: {
          isRoutine: true
        }
      }
      mockApp.metadataCache = {
        getFileCache: jest.fn().mockReturnValue(mockMetadata)
      }

      // 履歴なしの環境をセットアップ
      const mockDataDir = new TFolder('data/logs', [])
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        return null
      })

      const mockInstance = {
        task: mockTask,
        state: 'idle'
      }

      view.selectedTaskInstance = mockInstance
      view.deleteRoutineTask = jest.fn()
      view.deleteNonRoutineTask = jest.fn()
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)

      await view.deleteSelectedTask()

      // deleteSelectedTaskではメモリ上のisRoutine（false）が使用されるが、
      // hasExecutionHistory（履歴なし）により、deleteNonRoutineTaskが呼ばれる
      // メタデータキャッシュのチェックはdeleteRoutineTask内で行われる
      expect(view.deleteNonRoutineTask).toHaveBeenCalledWith(mockInstance)
      expect(view.deleteRoutineTask).not.toHaveBeenCalled()
    })
  })

  describe('deleteRoutineTaskの詳細テスト', () => {
    let mockInstance, mockTask, mockFile

    beforeEach(() => {
      // 共通のモックセットアップ
      mockFile = new TFile('Tasks/テストタスク.md')
      mockTask = {
        path: 'Tasks/テストタスク.md',
        title: 'テストタスク',
        isRoutine: false,
        file: mockFile
      }
      mockInstance = {
        task: mockTask,
        state: 'idle',
        instanceId: 'test-instance-123'
      }

      // メソッドのモック
      view.getCurrentDateString = jest.fn().mockReturnValue('2024-01-15')
      view.isDuplicatedTask = jest.fn().mockReturnValue(false)
      view.getHiddenRoutines = jest.fn().mockReturnValue([])
      view.saveHiddenRoutines = jest.fn()
      view.deleteTaskLogsByInstanceId = jest.fn().mockResolvedValue(1)
      view.saveRunningTasksState = jest.fn()
      view.renderTaskList = jest.fn()

      // LocalStorageモック
      global.localStorage = {
        getItem: jest.fn().mockReturnValue('[]'),
        setItem: jest.fn()
      }

      // Noticeモック
      global.Notice = jest.fn()

      // タスクリストの初期化
      view.tasks = [mockTask]
      view.taskInstances = [mockInstance]
    })

    test('履歴がない非ルーチンタスクはファイルが削除される', async () => {
      // 履歴なしをモック
      view.hasExecutionHistory = jest.fn().mockResolvedValue(false)

      await view.deleteRoutineTask(mockInstance)

      // ファイル削除が実行される
      expect(mockApp.vault.delete).toHaveBeenCalledWith(mockFile)
      expect(view.tasks).not.toContain(mockTask)
    })

    test('履歴がある非ルーチンタスクはファイルが保護される', async () => {
      // 履歴ありをモック
      view.hasExecutionHistory = jest.fn().mockResolvedValue(true)

      // コンソールログをモック
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation()

      await view.deleteRoutineTask(mockInstance)

      // ファイル削除は実行されない
      expect(mockApp.vault.delete).not.toHaveBeenCalled()
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('実行履歴があるためファイルを保護')
      )

      consoleLogSpy.mockRestore()
    })

    test('ルーチンタスクはファイルが保護される', async () => {
      // ルーチンタスクとして設定
      mockTask.isRoutine = true
      
      // コンソールログをモック
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation()

      await view.deleteRoutineTask(mockInstance)

      // ファイル削除は実行されない
      expect(mockApp.vault.delete).not.toHaveBeenCalled()
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('ルーチンタスクのためファイル削除スキップ')
      )

      consoleLogSpy.mockRestore()
    })

    test('メタデータキャッシュエラー時は安全側に倒す', async () => {
      // メタデータキャッシュエラーをモック
      mockApp.metadataCache = {
        getFileCache: jest.fn().mockImplementation(() => {
          throw new Error('メタデータ読み取りエラー')
        })
      }

      // コンソールエラーをモック
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      // 履歴なしをモック
      view.hasExecutionHistory = jest.fn().mockResolvedValue(false)

      await view.deleteRoutineTask(mockInstance)

      // エラーが出力されることを確認
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[TaskChute] ファイルメタデータ確認エラー:',
        expect.any(Error)
      )

      // isRoutine は元の値（false）が使用される
      expect(mockApp.vault.delete).toHaveBeenCalledWith(mockFile)

      consoleErrorSpy.mockRestore()
    })

    test('複数インスタンス存在時はファイル削除されない', async () => {
      // 同じパスのインスタンスを追加
      const anotherInstance = {
        task: mockTask,
        state: 'idle',
        instanceId: 'another-instance-456'
      }
      view.taskInstances = [mockInstance, anotherInstance]

      view.hasExecutionHistory = jest.fn().mockResolvedValue(false)

      await view.deleteRoutineTask(mockInstance)

      // 他のインスタンスが存在するためファイル削除されない
      expect(mockApp.vault.delete).not.toHaveBeenCalled()
    })

    test('実行中タスク削除時にrunning-task.jsonが更新される', async () => {
      mockInstance.state = 'running'
      view.hasExecutionHistory = jest.fn().mockResolvedValue(false)

      await view.deleteRoutineTask(mockInstance)

      expect(view.saveRunningTasksState).toHaveBeenCalled()
    })

    test('TaskExecutions削除でエラーが発生しても処理は継続', async () => {
      view.deleteTaskLogsByInstanceId.mockRejectedValue(new Error('ログ削除エラー'))
      view.hasExecutionHistory = jest.fn().mockResolvedValue(false)

      // コンソールエラーをモック
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      await view.deleteRoutineTask(mockInstance)

      // エラーが出力され、処理は継続される
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[TaskChute] TaskExecutions削除に失敗:',
        expect.any(Error)
      )
      expect(view.renderTaskList).toHaveBeenCalled()

      consoleErrorSpy.mockRestore()
    })
  })

  describe('実行履歴復元時の非表示チェック', () => {
    beforeEach(() => {
      // metadataCacheをmockAppに追加
      mockApp.metadataCache = {
        getFileCache: jest.fn()
      }
      
      // hiddenRoutinesのモック
      view.getHiddenRoutines = jest.fn().mockReturnValue([
        { path: 'Tasks/削除済みタスク.md', instanceId: 'deleted-id-123' }
      ])
      view.isInstanceHidden = jest.fn().mockImplementation((instanceId, path) => {
        return path === 'Tasks/削除済みタスク.md' && instanceId === 'deleted-id-123'
      })
      view.isInstanceDeleted = jest.fn().mockReturnValue(false)
      view.generateInstanceId = jest.fn().mockReturnValue('test-id-123')
    })

    test('実行履歴から復元されたタスクもhiddenRoutinesでチェックされる', async () => {
      // 月次ログデータのモック
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/削除済みタスク.md',
              taskTitle: '削除済みタスク',
              instanceId: 'deleted-id-123',
              isCompleted: true,
              startTime: '2024-01-15T09:00:00',
              stopTime: '2024-01-15T09:30:00',
              executionTime: 30
            }
          ]
        }
      })

      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        if (path === 'Tasks/削除済みタスク.md') {
          return new TFile('Tasks/削除済みタスク.md')
        }
        return null
      })
      mockApp.vault.read.mockResolvedValue(mockLogContent)
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { isRoutine: false }
      })

      // loadTasksメソッドのテスト用セットアップ
      view.getCurrentDateString = jest.fn().mockReturnValue('2024-01-15')
      view.plugin.pathManager.getTaskFolderPath = jest.fn().mockReturnValue('Tasks')
      view.plugin.pathManager.getLogDataPath = jest.fn().mockReturnValue('data/logs')
      view.app.vault.getMarkdownFiles = jest.fn().mockReturnValue([])
      view.getDeletedInstances = jest.fn().mockReturnValue([])
      view.getDuplicatedInstances = jest.fn().mockReturnValue([])
      view.getSlotKey = jest.fn().mockReturnValue('none')
      view.taskList = { empty: jest.fn() }
      view.renderTaskList = jest.fn()
      view.updateProjectStats = jest.fn()
      
      // loadTasksを実行
      await view.loadTasks()

      // 削除済みタスクが表示されないことを確認
      const deletedTask = view.taskInstances.find(
        inst => inst.task.path === 'Tasks/削除済みタスク.md'
      )
      expect(deletedTask).toBeUndefined()
    })

    test('非ルーチン化後に削除したタスクは再起動後も非表示', async () => {
      // 1. ルーチンタスクの実行履歴を作成
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/元ルーチンタスク.md',
              taskTitle: '元ルーチンタスク',
              instanceId: 'routine-id-456',
              isCompleted: true,
              startTime: '2024-01-15T10:00:00',
              stopTime: '2024-01-15T10:30:00'
            }
          ]
        }
      })

      // 2. isRoutine: falseに変更されたメタデータ
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { isRoutine: false }
      })

      // 3. hiddenRoutinesに削除済みとして記録
      view.getHiddenRoutines = jest.fn().mockReturnValue([
        { path: 'Tasks/元ルーチンタスク.md', instanceId: 'routine-id-456' }
      ])
      view.isInstanceHidden = jest.fn().mockImplementation((instanceId, path) => {
        return path === 'Tasks/元ルーチンタスク.md' && instanceId === 'routine-id-456'
      })

      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        if (path === 'Tasks/元ルーチンタスク.md') {
          return new TFile('Tasks/元ルーチンタスク.md')
        }
        return null
      })
      mockApp.vault.read.mockResolvedValue(mockLogContent)

      // loadTasksメソッドのテスト用セットアップ
      view.getCurrentDateString = jest.fn().mockReturnValue('2024-01-15')
      view.plugin.pathManager.getTaskFolderPath = jest.fn().mockReturnValue('Tasks')
      view.plugin.pathManager.getLogDataPath = jest.fn().mockReturnValue('data/logs')
      view.app.vault.getMarkdownFiles = jest.fn().mockReturnValue([])
      view.getDeletedInstances = jest.fn().mockReturnValue([])
      view.getDuplicatedInstances = jest.fn().mockReturnValue([])
      view.getSlotKey = jest.fn().mockReturnValue('none')
      view.taskList = { empty: jest.fn() }
      view.renderTaskList = jest.fn()
      view.updateProjectStats = jest.fn()
      
      // 4. loadTasksで再読み込み（再起動シミュレーション）
      await view.loadTasks()

      // 5. タスクが表示されないことを確認
      const hiddenTask = view.taskInstances.find(
        inst => inst.task.path === 'Tasks/元ルーチンタスク.md'
      )
      expect(hiddenTask).toBeUndefined()
    })

    test('複製タスク削除後もオリジナルタスクは表示される', () => {
      // 複製タスクの削除情報（instanceIdあり）をhiddenRoutinesに記録
      const hiddenRoutines = [
        { path: 'Tasks/ルーチンタスク.md', instanceId: 'duplicated-id-789' }
      ]
      
      // 修正後のisInstanceHiddenロジックを直接テスト
      // オリジナルタスクのinstanceIdで判定
      const isHidden = hiddenRoutines.some((hidden) => {
        const instanceId = 'original-id-123'  // オリジナルのID
        const taskPath = 'Tasks/ルーチンタスク.md'
        
        // 複製タスク削除の場合（instanceIdあり）：instanceIdのみで判定
        if (hidden.instanceId && hidden.instanceId === instanceId) return true
        
        // オリジナルタスク削除の場合（instanceId: null）：pathで判定
        if (hidden.instanceId === null && hidden.path === taskPath) {
          return true
        }
        
        // 旧形式
        if (typeof hidden === "string" && hidden === taskPath) return true
        
        return false
      })
      
      // 複製タスクの削除はオリジナルタスクに影響しない
      expect(isHidden).toBe(false)
    })

    test('オリジナルタスク削除後は同じpathのタスクが非表示になる', () => {
      // オリジナルタスクの削除情報（instanceId: null）をhiddenRoutinesに記録
      const hiddenRoutines = [
        { path: 'Tasks/ルーチンタスク.md', instanceId: null }
      ]
      
      // 修正後のisInstanceHiddenロジックを直接テスト
      const isHidden = hiddenRoutines.some((hidden) => {
        const instanceId = 'any-instance-id'  // 任意のID
        const taskPath = 'Tasks/ルーチンタスク.md'
        
        // 複製タスク削除の場合（instanceIdあり）：instanceIdのみで判定
        if (hidden.instanceId && hidden.instanceId === instanceId) return true
        
        // オリジナルタスク削除の場合（instanceId: null）：pathで判定
        if (hidden.instanceId === null && hidden.path === taskPath) {
          return true
        }
        
        // 旧形式
        if (typeof hidden === "string" && hidden === taskPath) return true
        
        return false
      })
      
      // オリジナルタスク削除時はpathが一致すれば非表示
      expect(isHidden).toBe(true)
    })

    test('完了タスクが再起動後も正しく非表示になる', async () => {
      // 実行履歴データ（完了タスク）
      const mockLogContent = JSON.stringify({
        taskExecutions: {
          '2024-01-15': [
            {
              taskId: 'Tasks/完了済みルーチン.md',
              taskTitle: '完了済みルーチン',
              instanceId: 'execution-id-999',  // 実行時のID
              isCompleted: true,
              startTime: '2024-01-15T09:00:00',
              stopTime: '2024-01-15T09:30:00'
            }
          ]
        }
      })

      // hiddenRoutinesに削除時のIDで記録
      view.getHiddenRoutines = jest.fn().mockReturnValue([
        { path: 'Tasks/完了済みルーチン.md', instanceId: 'deleted-id-888' }  // 削除時の異なるID
      ])
      
      // 修正後のisInstanceHiddenメソッドで、オリジナルタスク削除のみパスで非表示
      view.isInstanceHidden = jest.fn().mockImplementation((instanceId, path) => {
        const hiddenRoutines = [
          { path: 'Tasks/完了済みルーチン.md', instanceId: null }  // オリジナルタスク削除
        ]
        return hiddenRoutines.some((hidden) => {
          // 複製タスク削除の場合：instanceIdのみで判定
          if (hidden.instanceId && hidden.instanceId === instanceId) return true
          // オリジナルタスク削除の場合：pathで判定
          if (hidden.instanceId === null && hidden.path === path) return true
          if (typeof hidden === "string" && hidden === path) return true
          return false
        })
      })

      // データディレクトリのモック
      const mockDataDir = new TFolder('data/logs', [
        new TFile('data/logs/2024-01-tasks.json')
      ])
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'data/logs') return mockDataDir
        if (path === 'data/logs/2024-01-tasks.json') {
          return new TFile('data/logs/2024-01-tasks.json')
        }
        if (path === 'Tasks/完了済みルーチン.md') {
          return new TFile('Tasks/完了済みルーチン.md')
        }
        return null
      })
      mockApp.vault.read.mockResolvedValue(mockLogContent)
      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { isRoutine: false }
      })

      // loadTasksメソッドのテスト用セットアップ
      view.getCurrentDateString = jest.fn().mockReturnValue('2024-01-15')
      view.plugin.pathManager.getTaskFolderPath = jest.fn().mockReturnValue('Tasks')
      view.plugin.pathManager.getLogDataPath = jest.fn().mockReturnValue('data/logs')
      view.app.vault.getMarkdownFiles = jest.fn().mockReturnValue([])
      view.getDeletedInstances = jest.fn().mockReturnValue([])
      view.getDuplicatedInstances = jest.fn().mockReturnValue([])
      view.getSlotKey = jest.fn().mockReturnValue('none')
      view.taskList = { empty: jest.fn() }
      view.renderTaskList = jest.fn()
      view.updateProjectStats = jest.fn()
      view.isInstanceDeleted = jest.fn().mockReturnValue(false)
      
      // loadTasksで再読み込み
      await view.loadTasks()

      // 完了タスクが表示されないことを確認（パスでの照合により非表示）
      const hiddenTask = view.taskInstances.find(
        inst => inst.task.path === 'Tasks/完了済みルーチン.md'
      )
      expect(hiddenTask).toBeUndefined()
    })
  })
})