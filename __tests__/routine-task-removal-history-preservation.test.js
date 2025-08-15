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

    test('エラー発生時は安全側（true）を返す', async () => {
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
        '履歴チェックエラー:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
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
  })
})