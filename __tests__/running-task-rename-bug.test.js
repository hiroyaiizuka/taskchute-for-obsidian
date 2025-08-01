const { TaskChuteView } = require('../main.js')

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
        }
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
      
      view.app.vault.adapter.exists.mockResolvedValue(true)
      view.app.vault.adapter.read.mockResolvedValue(initialData)
      
      // updateRunningTaskPathを実行
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      // writeが呼ばれたことを確認
      expect(view.app.vault.adapter.write).toHaveBeenCalled()
      
      // 書き込まれたデータを確認
      const writtenData = JSON.parse(view.app.vault.adapter.write.mock.calls[0][1])
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
      
      view.app.vault.adapter.exists.mockResolvedValue(true)
      view.app.vault.adapter.read.mockResolvedValue(initialData)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      // writeが呼ばれていないことを確認
      expect(view.app.vault.adapter.write).not.toHaveBeenCalled()
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
      
      view.app.vault.adapter.exists.mockResolvedValue(true)
      view.app.vault.adapter.read.mockResolvedValue(initialData)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      const writtenData = JSON.parse(view.app.vault.adapter.write.mock.calls[0][1])
      expect(writtenData).toHaveLength(2)
      expect(writtenData[0].taskPath).toBe('tasks/タスクB.md')
      expect(writtenData[0].taskTitle).toBe('タスクB')
      expect(writtenData[1].taskPath).toBe('tasks/タスクC.md')
      expect(writtenData[1].taskTitle).toBe('タスクC')
    })

    test('running-task.jsonが存在しない場合は何もしない', async () => {
      view.app.vault.adapter.exists.mockResolvedValue(false)
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      expect(view.app.vault.adapter.read).not.toHaveBeenCalled()
      expect(view.app.vault.adapter.write).not.toHaveBeenCalled()
    })

    test('データが配列でない場合は何もしない', async () => {
      view.app.vault.adapter.exists.mockResolvedValue(true)
      view.app.vault.adapter.read.mockResolvedValue('{}') // オブジェクトを返す
      
      await view.updateRunningTaskPath('tasks/タスクA.md', 'tasks/タスクB.md', 'タスクB')
      
      expect(view.app.vault.adapter.write).not.toHaveBeenCalled()
    })
  })
})