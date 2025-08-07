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

describe('実行中タスクの名前変更バグ', () => {
  let view
  
  beforeEach(() => {
    // 最小限のモック
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView({ app: {} }, mockPlugin)
    view.app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn().mockResolvedValue('[]'),
          write: jest.fn().mockResolvedValue()
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn()
      }
    }
  })

  describe('updateRunningTaskPath', () => {
    test('実行中タスクのパスとタイトルを更新する', async () => {
      // running-task.jsonの初期データを設定
      const initialData = JSON.stringify([
        {
          taskPath: 'tasks/タスクA.md',
          taskTitle: 'タスクA',
          date: '2024-01-15',
          startTime: '2024-01-15T09:00:00.000Z'
        }
      ], null, 2)
      
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/running-task.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      view.app.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      view.app.vault.read.mockResolvedValue(initialData)
      
      // updateRunningTaskPathを実行
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      // modifyが呼ばれたことを確認
      expect(view.app.vault.modify).toHaveBeenCalled()
      
      // 書き込まれたデータを確認
      const writtenData = JSON.parse(view.app.vault.modify.mock.calls[0][1])
      expect(writtenData[0].taskPath).toBe('tasks/タスクB.md')
      expect(writtenData[0].taskTitle).toBe('タスクB')
    })

    test('該当するタスクがない場合は何もしない', async () => {
      const initialData = JSON.stringify([
        {
          taskPath: 'tasks/別のタスク.md',
          taskTitle: '別のタスク',
          date: '2024-01-15',
          startTime: '2024-01-15T09:00:00.000Z'
        }
      ], null, 2)
      
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/running-task.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      view.app.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      view.app.vault.read.mockResolvedValue(initialData)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      // modifyが呼ばれていないことを確認
      expect(view.app.vault.modify).not.toHaveBeenCalled()
    })

    test('複数のタスクがある場合、対象のタスクのみ更新する', async () => {
      const initialData = JSON.stringify([
        {
          taskPath: 'tasks/タスクA.md',
          taskTitle: 'タスクA',
          date: '2024-01-15',
          startTime: '2024-01-15T09:00:00.000Z'
        },
        {
          taskPath: 'tasks/タスクC.md',
          taskTitle: 'タスクC',
          date: '2024-01-15',
          startTime: '2024-01-15T10:00:00.000Z'
        }
      ], null, 2)
      
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/running-task.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      view.app.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      view.app.vault.read.mockResolvedValue(initialData)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      const writtenData = JSON.parse(view.app.vault.modify.mock.calls[0][1])
      expect(writtenData).toHaveLength(2)
      expect(writtenData[0].taskPath).toBe('tasks/タスクB.md')
      expect(writtenData[0].taskTitle).toBe('タスクB')
      expect(writtenData[1].taskPath).toBe('tasks/タスクC.md')
      expect(writtenData[1].taskTitle).toBe('タスクC')
    })

    test('running-task.jsonが存在しない場合は何もしない', async () => {
      view.app.vault.getAbstractFileByPath.mockReturnValue(null)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      expect(view.app.vault.read).not.toHaveBeenCalled()
      expect(view.app.vault.modify).not.toHaveBeenCalled()
    })

    test('データが配列でない場合は何もしない', async () => {
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/running-task.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      view.app.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      view.app.vault.read.mockResolvedValue('{}') // オブジェクトを返す
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      expect(view.app.vault.modify).not.toHaveBeenCalled()
    })
  })
})